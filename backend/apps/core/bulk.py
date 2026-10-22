"""Admin bulk actions and list filters (select-all, bulk toolbar, advanced filter).

One endpoint per resource, `POST /api/v1/admin/<resource>/bulk-action`, takes either explicit ids or the same
validated filter the list screen uses ("all N filtered results"), so the browser never has to load thousands of ids.

    {"action": "suspend", "ids": [3, 4, 9], "reason": "…"}
    {"action": "suspend", "filter": {"role": "student", "status": "active"}, "expected": 235, "exclude_ids": [7], "reason": "…"}

Safety rules:
- Admins only (IsAdminRole, MFA enforced like every admin view).
- Every action is declared per resource; anything else is refused. Actions never hard-delete history: people are
  suspended or archived, bookings and sessions are cancelled, content is archived. "delete" exists only for drafts
  with nothing attached (no sessions, lessons, enrollments, attempts, completions); anything else is reported as
  protected and left untouched.
- Each record runs in its own transaction (savepoint): a failure rolls back that record only and is reported.
- Filter mode re-runs the validated filter on the server. If the number of matches changed since the admin looked
  (`expected`), nothing happens and the new count is returned, so a filter never silently hits more records.
- Large destructive requests must carry `confirm: "حذف"` (the UI asks the admin to type it).
- One audit event per request: resource, action, counts, affected ids, filter, reason. No secrets or media URLs.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Callable
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import ProtectedError, Q, QuerySet
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole

from .audit import audit
from .exceptions import ApiError

MAX_IDS = 500            # explicit selection per request
MAX_FILTERED = 5000      # "all filtered results" per request
CONFIRM_WORD = "حذف"
CONFIRM_FROM = 10        # destructive actions on this many records or more need the typed confirmation
CAIRO = ZoneInfo("Africa/Cairo")


class Skip(Exception):
    """Nothing to do for this record (already in the requested state)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class Refuse(Exception):
    """This record may not take the action (protected history, wrong state). Reported to the admin."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# ---- Filters ---------------------------------------------------------------------------
def bad(field_name: str, msg: str = "قيمة غير صالحة.") -> ApiError:
    return ApiError("invalid_filter", "تحقق من عوامل التصفية.", 400, {field_name: [msg]})


def p_int(name: str, v: str) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise bad(name) from None
    if n < 1:
        raise bad(name)
    return n


def p_choice(*choices: str) -> Callable[[str, str], str]:
    def parse(name: str, v: str) -> str:
        if v not in choices:
            raise bad(name)
        return v
    return parse


def p_bool(name: str, v: str) -> bool:
    if v in ("1", "true", "yes"):
        return True
    if v in ("0", "false", "no"):
        return False
    raise bad(name)


def p_date(name: str, v: str) -> date:
    try:
        return date.fromisoformat(v)
    except (TypeError, ValueError):
        raise bad(name, "صيغة التاريخ YYYY-MM-DD.") from None


def p_text(name: str, v: str) -> str:
    v = str(v).strip()
    if len(v) > 100:
        raise bad(name, "نص البحث طويل جدًا.")
    return v


def day_start(d: date) -> datetime:
    """Start of a Cairo calendar day as an aware datetime (filters are typed in Cairo dates)."""
    return datetime.combine(d, time.min, tzinfo=CAIRO)


def day_end(d: date) -> datetime:
    return day_start(d + timedelta(days=1))


def date_range(qs: QuerySet, f: dict, field_name: str, frm: str, to: str) -> QuerySet:
    if frm in f:
        qs = qs.filter(**{f"{field_name}__gte": day_start(f[frm])})
    if to in f:
        qs = qs.filter(**{f"{field_name}__lt": day_end(f[to])})
    return qs


def search_q(text: str, fields: list[str], id_field: str = "pk") -> Q:
    """Name/email/title search; a number also matches the record id (reference)."""
    q = Q()
    for f_ in fields:
        q |= Q(**{f"{f_}__icontains": text})
    if text.isdigit():
        q |= Q(**{id_field: int(text)})
    return q


@dataclass
class FilterSpec:
    """Validated filter + sort for one list. `apply(qs, f)` gets the parsed values only."""

    parsers: dict[str, Callable[[str, Any], Any]]
    apply: Callable[[QuerySet, dict], QuerySet]
    sorts: dict[str, tuple[str, ...]]           # public key -> order_by fields (ascending)
    default_sort: str

    def parse(self, raw, strict: bool) -> dict:
        out = {}
        for k, v in (raw.items() if hasattr(raw, "items") else []):
            if k in ("page", "page_size", "sort"):
                continue
            if k not in self.parsers:
                if strict:
                    raise bad(k, "عامل تصفية غير معروف.")
                continue
            if v in ("", None):
                continue
            out[k] = self.parsers[k](k, v if isinstance(v, (str, int)) else str(v))
        return out

    def order(self, qs: QuerySet, sort: str | None) -> QuerySet:
        sort = sort or self.default_sort
        desc = sort.startswith("-")
        key = sort.lstrip("-")
        if key not in self.sorts:
            raise bad("sort", "ترتيب غير مدعوم.")
        fields = [("-" if desc else "") + f_ for f_ in self.sorts[key]]
        return qs.order_by(*fields, "-pk" if desc else "pk")

    def run(self, base: QuerySet, raw, *, strict=False, sort: str | None = None) -> QuerySet:
        f = self.parse(raw, strict)
        return self.order(self.apply(base, f), sort)


# ---- Actions and resources ---------------------------------------------------------------
@dataclass
class Action:
    run: Callable[..., None]                # (obj, actor, reason, **params) -> None; raise Skip / Refuse
    reason_required: bool = False
    destructive: bool = False               # needs the typed confirmation at CONFIRM_FROM records or more
    confirm_always: bool = False            # irreversible: the typed confirmation is needed even for one record
    # Validates the request's `params` once, before any record is touched: (raw dict, actor) -> kwargs for `run`.
    # Raise ApiError for an invalid parameter (e.g. a teacher who is not approved).
    params: Callable[[dict, Any], dict] | None = None
    audit_keys: tuple[str, ...] = ()        # which validated params go into the audit event (ids, titles; no free text)


@dataclass
class Resource:
    name: str                               # URL segment
    label: str                              # for the audit log
    base: Callable[[], QuerySet]            # all records an admin may act on
    filters: FilterSpec | None
    actions: dict[str, Action]
    describe: Callable[[Any], str] = str    # short label in results (names/titles; never emails or URLs)
    lock: bool = True                       # select_for_update each record before the action
    extra: dict = field(default_factory=dict)
    # CSV export columns: (Arabic header, value function). Names, dates, states and counts only: never secrets,
    # tokens, media URLs or private notes.
    export: list[tuple[str, Callable[[Any], Any]]] = field(default_factory=list)


REGISTRY: dict[str, Resource] = {}


def register(r: Resource) -> Resource:
    REGISTRY[r.name] = r
    return r


def _ids(raw) -> list[int]:
    if not isinstance(raw, list):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"ids": ["قائمة أرقام."]})
    out = []
    for x in raw:
        if isinstance(x, bool) or not isinstance(x, (int, str)) or not str(x).isdigit():
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"ids": ["قائمة أرقام."]})
        out.append(int(x))
    return list(dict.fromkeys(out))  # de-duplicated, order kept


class AdminBulkAction(APIView):
    admin_any = True  # own data, or checks per action/resource inside
    permission_classes = [IsAdminRole]

    def post(self, request, resource: str):
        res = REGISTRY.get(resource)
        if res is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        d = request.data if isinstance(request.data, dict) else {}
        name = d.get("action")
        act = res.actions.get(name) if isinstance(name, str) else None
        if act is None:
            raise ApiError("invalid_action", "إجراء غير مسموح على هذا النوع.", 400, {"action": ["اختر إجراءً صالحًا."]})
        from apps.accounts import admin_access as aa

        need = aa.bulk_perm(resource, name)
        if need is None:
            raise ApiError("admin_permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        aa.require(request.user, need)
        if (resource, name) in aa.FRESH_MFA_ACTIONS:
            aa.require_fresh_mfa(request)
        reason = str(d.get("reason", "")).strip()[:200]
        if act.reason_required and len(reason) < 3:
            raise ApiError("invalid", "اكتب سبب الإجراء.", 400, {"reason": ["اكتب سبب الإجراء (3 أحرف على الأقل)."]})

        params = act.params(d.get("params") if isinstance(d.get("params"), dict) else {}, request.user) if act.params else {}
        mode, targets, missing, filt = resolve_targets(res, d, MAX_IDS, MAX_FILTERED, check_expected=True)

        requested = len(targets) + len(missing)
        if (act.confirm_always or (act.destructive and requested >= CONFIRM_FROM)) and d.get("confirm") != CONFIRM_WORD:
            raise ApiError("confirm_required", f"اكتب «{CONFIRM_WORD}» للتأكيد.", 400, {"confirm": [f"اكتب «{CONFIRM_WORD}» للتأكيد."]})

        done, skipped, results = [], [], []
        for pk in missing:
            results.append({"id": pk, "label": "", "outcome": "failed", "code": "not_found", "message": "غير موجود أو غير مسموح."})
        failed = len(missing)
        for pk in targets:
            label = ""
            try:
                with transaction.atomic():
                    qs = res.base().filter(pk=pk)
                    obj = (qs.select_for_update(of=("self",)) if res.lock else qs).get()
                    label = res.describe(obj)
                    act.run(obj, request.user, reason, **params)
                done.append(pk)
            except Skip as e:
                skipped.append(pk)
                results.append({"id": pk, "label": label, "outcome": "skipped", "code": e.code, "message": e.message})
            except (Refuse, ApiError, ProtectedError) as e:
                failed += 1
                code = getattr(e, "code", "protected")
                msg = getattr(e, "message", None) or (e.detail if isinstance(e, ApiError) else "مرتبط بسجلات محفوظة؛ لا يمكن حذفه.")
                results.append({"id": pk, "label": label, "outcome": "failed", "code": str(code), "message": str(msg)})

        audit(f"admin.bulk_{name}", actor=request.user, request=request, resource=res.label, mode=mode, requested=requested,
              success=len(done), skipped=len(skipped), failed=failed, ids=done[:1000], filter=_jsonable(filt), reason=reason,
              params=_jsonable({k: _plain(params[k]) for k in act.audit_keys if k in params}) or None)
        return Response({"requested": requested, "success": len(done), "skipped": len(skipped), "failed": failed,
                         "results": results[:200], "errors": [r for r in results if r["outcome"] == "failed"][:200]})


def resolve_targets(res: Resource, d: dict, max_ids: int, max_filtered: int, *, check_expected: bool):
    """The records a request names: explicit `ids`, or the resource's validated `filter` (minus `exclude_ids`).
    Returns (mode, existing ids, missing ids, parsed filter)."""
    if "filter" not in d:
        ids = _ids(d.get("ids"))
        if not ids:
            raise ApiError("invalid", "لم يُحدَّد أي عنصر.", 400, {"ids": ["حدّد عنصرًا واحدًا على الأقل."]})
        if len(ids) > max_ids:
            raise ApiError("too_many", f"الحد الأقصى {max_ids} عنصر في الطلب الواحد. استخدم «تحديد جميع النتائج».", 400)
        found = set(res.base().filter(pk__in=ids).values_list("pk", flat=True))
        return "ids", [i for i in ids if i in found], [i for i in ids if i not in found], None
    if res.filters is None or not isinstance(d.get("filter"), dict):
        raise ApiError("invalid", "التصفية غير مدعومة هنا.", 400)
    filt = res.filters.parse(d["filter"], strict=True)
    exclude = _ids(d.get("exclude_ids", []))
    qs = res.filters.apply(res.base(), filt).exclude(pk__in=exclude)
    targets = list(qs.order_by("pk").values_list("pk", flat=True).distinct()[: max_filtered + 1])
    if len(targets) > max_filtered:
        raise ApiError("too_many", f"النتائج أكثر من {max_filtered}. ضيّق التصفية.", 400)
    if check_expected:
        expected = d.get("expected")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected != len(targets):
            raise ApiError("results_changed", "تغيّرت نتائج التصفية منذ عرضها. راجع العدد الجديد ثم أعد المحاولة.", 409,
                           {"expected": [str(len(targets))]})
    return "filter", targets, [], filt


def _plain(v):
    return getattr(v, "pk", v)


MAX_EXPORT = 20000


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "نعم" if v else "لا"
    if isinstance(v, datetime):
        return v.astimezone(CAIRO).strftime("%Y-%m-%d %H:%M")
    if isinstance(v, date):
        return v.isoformat()
    v = str(v)
    # Spreadsheet formula injection: a cell that starts with = + - @ (or a tab/CR) is kept as text.
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


class AdminBulkExport(APIView):
    """CSV of the selected rows or of the whole filtered result (same rules as bulk actions; up to 20,000 rows).
    UTF-8 with a BOM so Excel shows Arabic correctly; times in Cairo time. One audit event per export."""
    admin_any = True  # own data, or checks per action/resource inside

    permission_classes = [IsAdminRole]

    def post(self, request, resource: str):
        import csv
        import io

        from django.http import HttpResponse
        from django.utils import timezone as tz

        res = REGISTRY.get(resource)
        if res is None or not res.export:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        from apps.accounts import admin_access as aa

        read = aa.bulk_perm(resource, None)
        aa.require(request.user, "exports.create")
        aa.require(request.user, read or "admins.manage")
        if resource == "users":  # the people export carries emails and phone numbers
            aa.require(request.user, "users.view_contact")
        d = request.data if isinstance(request.data, dict) else {}
        mode, targets, _missing, filt = resolve_targets(res, d, MAX_EXPORT, MAX_EXPORT, check_expected=False)
        qs = res.base().filter(pk__in=targets)
        sort = d.get("sort") if isinstance(d.get("sort"), str) else None
        qs = res.filters.order(qs, sort) if res.filters else qs.order_by("pk")
        buf = io.StringIO()
        buf.write("\ufeff")
        w = csv.writer(buf)
        w.writerow([h for h, _ in res.export])
        n = 0
        for obj in qs.iterator(chunk_size=500):
            w.writerow([_cell(fn(obj)) for _, fn in res.export])
            n += 1
        audit("admin.export", actor=request.user, request=request, resource=res.label, mode=mode, rows=n, filter=_jsonable(filt))
        out = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
        out["Content-Disposition"] = f'attachment; filename="halqa-{resource}-{tz.localtime(tz.now(), CAIRO):%Y%m%d-%H%M}.csv"'
        out["Cache-Control"] = "no-store"
        return out


def _jsonable(f):
    if f is None:
        return None
    return {k: (v.isoformat() if isinstance(v, (date, datetime)) else v) for k, v in f.items()}


def list_with(view: APIView, request, base: QuerySet, spec: FilterSpec, out: Callable[[Any], dict]):
    """Paginated admin list using a resource's validated filter and sort (same rules as bulk filter mode)."""
    from .pagination import StandardPagination

    qs = spec.run(base, request.query_params, sort=request.query_params.get("sort"))
    p = StandardPagination()
    return p.get_paginated_response([out(x) for x in p.paginate_queryset(qs, request, view=view)])


# ---- Saved views ---------------------------------------------------------------------------
SAVED_VIEW_LIMIT = 30


class AdminSavedViews(APIView):
    """GET ?section= → the admin's own presets; POST {section, name, query}. The query is validated against the
    section's filter rules before it is stored, so a preset can never carry unknown keys or free-form data."""
    admin_any = True  # own data, or checks per action/resource inside

    permission_classes = [IsAdminRole]
    SECTIONS = {"students": "users", "teachers": "users", "parents": "users", "circles": "circles", "bookings": "bookings",
                "sessions": "sessions", "courses": "courses", "lectures": "courses", "lessons": "lessons", "enrollments": "enrollments", "quizzes": "tests"}

    @staticmethod
    def out(v):
        return {"id": v.id, "section": v.section, "name": v.name, "query": v.query}

    def get(self, request):
        from .models import SavedView

        qs = SavedView.objects.filter(owner=request.user)
        if request.query_params.get("section"):
            qs = qs.filter(section=request.query_params["section"])
        return Response([self.out(v) for v in qs])

    def post(self, request):
        from urllib.parse import parse_qsl, urlencode

        from django.db import IntegrityError

        from .models import SavedView

        d = request.data if isinstance(request.data, dict) else {}
        section, name, query = str(d.get("section", "")), str(d.get("name", "")).strip(), str(d.get("query", "")).lstrip("?")
        if section not in self.SECTIONS:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"section": ["قسم غير معروف."]})
        if not 2 <= len(name) <= 60:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"name": ["الاسم من 2 إلى 60 حرفًا."]})
        pairs = [(k, v) for k, v in parse_qsl(query[:1000]) if k not in ("page", "page_size")]
        res = REGISTRY[self.SECTIONS[section]]
        if res.filters:
            res.filters.parse({k: v for k, v in pairs if k != "sort"}, strict=True)
            if any(k == "sort" for k, _ in pairs):
                res.filters.order(res.base().none(), dict(pairs)["sort"])
        if SavedView.objects.filter(owner=request.user).count() >= SAVED_VIEW_LIMIT:
            raise ApiError("too_many", f"الحد الأقصى {SAVED_VIEW_LIMIT} عرضًا محفوظًا.", 400)
        try:
            with transaction.atomic():
                v = SavedView.objects.create(owner=request.user, section=section, name=name, query=urlencode(pairs))
        except IntegrityError:
            raise ApiError("duplicate", "يوجد عرض محفوظ بهذا الاسم.", 409, {"name": ["اختر اسمًا آخر."]}) from None
        return Response(self.out(v), status=201)


class AdminSavedViewDetail(APIView):
    admin_any = True  # own data, or checks per action/resource inside
    permission_classes = [IsAdminRole]

    def delete(self, request, pk: int):
        from .models import SavedView

        n, _ = SavedView.objects.filter(owner=request.user, pk=pk).delete()
        if not n:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        return Response(status=204)
