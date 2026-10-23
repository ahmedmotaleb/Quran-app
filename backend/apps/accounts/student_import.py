"""CSV bulk student import (PROMPT 50).

Flow: the admin uploads a UTF-8 CSV → the server validates the whole file and returns a per-row preview (valid,
duplicate, error) without writing anything (`dry_run`, the default) → the admin confirms by sending the same file with
`dry_run=false` → the server validates again, creates every valid row in its own transaction (so one failure never
loses the others), sends the password-setup emails directly and returns a per-row result. Nothing is skipped silently:
every row not created is reported with its reason, and the screen offers it back as an error CSV.

Rules kept: no passwords are stored (the person sets one from the email); phones are saved as contact numbers and
never marked verified; an email that already exists or repeats in the file is never created twice; teacher links and
circle seats go through the same checks as the single-record screens (approved active teacher; published circle with
free seats, counted across the whole file); columns that link teachers or circles need those permissions too.
"""
from __future__ import annotations

import csv
import io
import logging
import time as _time
from zoneinfo import available_timezones

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings
from apps.scheduling.membership import MembershipError

from . import phones
from .admin_access import has
from .models import AccountStatus, Role, StudentProfile, TeacherAssignment, User
from .permissions import IsAdminRole

log = logging.getLogger(__name__)

COLUMNS = ["full_name", "email", "phone", "timezone", "level", "teacher_email", "circle"]
REQUIRED = ["full_name", "email"]
MAX_ROWS = 500
MAX_BYTES = 1024 * 1024
EMAIL_BUDGET_SECONDS = 45  # Cloud Run answers within 120 s; emails not sent in time are reported as «لم يُرسل بعد»
TEMPLATE_NOTE = "full_name,email,phone,timezone,level,teacher_email,circle"


def _fail(msg: str) -> ApiError:
    return ApiError("invalid_file", msg, 400, {"file": [msg]})


def read_csv(upload) -> list[dict]:
    if upload is None:
        raise _fail("اختر ملف CSV.")
    if upload.size > MAX_BYTES:
        raise _fail("حجم الملف أكبر من 1 ميغابايت.")
    raw = upload.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise _fail("احفظ الملف بترميز UTF-8 (في Excel: «CSV UTF-8»).") from None
    if "\0" in text:
        raise _fail("الملف ليس ملف CSV نصيًا.")
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    if not headers:
        raise _fail("الملف فارغ.")
    unknown = [h for h in headers if h not in COLUMNS]
    missing = [h for h in REQUIRED if h not in headers]
    if unknown:
        raise _fail(f"أعمدة غير معروفة: {', '.join(unknown)}. الأعمدة المسموحة: {', '.join(COLUMNS)}.")
    if missing:
        raise _fail(f"أعمدة ناقصة: {', '.join(missing)}.")
    if len(set(headers)) != len(headers):
        raise _fail("عمود مكرر في رأس الملف.")
    reader.fieldnames = headers
    rows = []
    for i, r in enumerate(reader, start=2):  # line 1 is the header
        if None in r:  # more cells than headers
            rows.append({"line": i, "data": {k: (r.get(k) or "").strip() for k in headers}, "extra": True})
        else:
            data = {k: (r.get(k) or "").strip() for k in headers}
            if any(data.values()):
                rows.append({"line": i, "data": data})
        if len(rows) > MAX_ROWS:
            raise _fail(f"الحد الأقصى {MAX_ROWS} صف في الملف الواحد. قسّم الملف.")
    if not rows:
        raise _fail("لا توجد صفوف بيانات تحت رأس الملف.")
    return rows


def validate(rows: list[dict], admin) -> dict:
    from apps.scheduling.membership import active_count
    from apps.scheduling.models import Circle

    used = {c for r in rows for c in ("teacher_email", "circle", "phone") if r["data"].get(c)}
    if "phone" in used and not has(admin, "users.view_contact"):
        raise _fail("عمود phone يتطلب صلاحية «عرض بيانات التواصل». احذف العمود أو اطلب الصلاحية.")
    if "teacher_email" in used and not has(admin, "teachers.assign"):
        raise _fail("عمود teacher_email يتطلب صلاحية «ربط الطلاب بالمعلمين». احذف العمود أو اطلب الصلاحية.")
    if "circle" in used and not has(admin, "circles.manage"):
        raise _fail("عمود circle يتطلب صلاحية «إدارة الحلقات». احذف العمود أو اطلب الصلاحية.")
    default_tz = AppSettings.load().default_timezone or "Africa/Cairo"
    zones = available_timezones()
    emails = [r["data"].get("email", "").lower() for r in rows]
    existing = set(User.objects.filter(email__in=[e for e in emails if e]).values_list("email", flat=True))
    teachers = {u.email: u for u in User.objects.filter(role=Role.TEACHER, status=AccountStatus.ACTIVE,
                                                         teacher_profile__approved_at__isnull=False,
                                                         email__in={r["data"].get("teacher_email", "").lower() for r in rows} - {""})}
    circles_by, names = {}, {}
    for c in Circle.objects.filter(state=Circle.State.PUBLISHED):
        circles_by[str(c.pk)] = c
        circles_by.setdefault(c.name.strip(), c)
        names[c.name.strip()] = names.get(c.name.strip(), 0) + 1
    seats = {}
    seen = set()
    out = []
    for r in rows:
        d, errs, status = r["data"], [], "valid"
        clean = {"full_name": d.get("full_name", ""), "email": d.get("email", "").lower()}
        if r.get("extra"):
            errs.append("خلايا أكثر من أعمدة الرأس (فاصلة زائدة؟).")
        if not 2 <= len(clean["full_name"]) <= 120:
            errs.append("الاسم مطلوب (2–120 حرفًا).")
        try:
            validate_email(clean["email"])
        except ValidationError:
            errs.append("بريد إلكتروني غير صالح.")
        if d.get("phone"):
            p = phones.normalize(d["phone"])
            if not p:
                errs.append("رقم هاتف غير صالح.")
            clean["phone"] = p
        tz = d.get("timezone") or default_tz
        if tz not in zones:
            errs.append("منطقة زمنية غير معروفة (مثال: Africa/Cairo).")
        clean["timezone"] = tz
        if len(d.get("level", "")) > 32:
            errs.append("المستوى أطول من 32 حرفًا.")
        clean["level"] = d.get("level", "")
        if d.get("teacher_email"):
            t = teachers.get(d["teacher_email"].lower())
            if t is None:
                errs.append("المعلم غير موجود أو غير معتمد أو غير نشط.")
            else:
                clean["teacher"] = {"id": t.pk, "name": t.full_name}
        if d.get("circle"):
            key = d["circle"].strip()
            c = circles_by.get(key)
            if c is None:
                errs.append("الحلقة غير موجودة أو غير منشورة.")
            elif not key.isdigit() and names.get(key, 0) > 1:
                errs.append("يوجد أكثر من حلقة بهذا الاسم؛ اكتب رقم الحلقة بدل اسمها.")
            else:
                clean["circle"] = {"id": c.pk, "name": c.name}
        if not errs and clean["email"] in existing:
            status, errs = "duplicate", ["البريد مستخدم لحساب موجود."]
        elif not errs and clean["email"] in seen:
            status, errs = "duplicate", ["البريد مكرر في الملف (يُنشأ أول ظهور فقط)."]
        elif errs:
            status = "error"
        if status == "valid" and "circle" in clean:
            c = circles_by[d["circle"].strip()]
            if c.pk not in seats:
                seats[c.pk] = c.capacity - active_count(c)
            if seats[c.pk] <= 0:
                status, errs = "error", [f"لا مقاعد متبقية في «{c.name}» (السعة {c.capacity})."]
            else:
                seats[c.pk] -= 1
        if status == "valid":
            seen.add(clean["email"])
        out.append({"line": r["line"], "data": d, "clean": clean, "status": status, "errors": errs})
    summary = {k: sum(1 for x in out if x["status"] == k) for k in ("valid", "duplicate", "error")}
    return {"rows": out, "summary": {**summary, "total": len(out)}}


def create_row(row: dict, admin, request) -> User:
    from apps.scheduling import membership
    from apps.scheduling.models import Circle

    c = row["clean"]
    with transaction.atomic():
        user = User.objects.create_user(c["email"], None, full_name=c["full_name"], role=Role.STUDENT, timezone=c["timezone"],
                                        phone=c.get("phone", ""))  # a contact number only: never verified here
        StudentProfile.objects.create(user=user, level=c.get("level", ""))
        audit("admin.user_created", actor=admin, target=user, request=request, role=Role.STUDENT, source="csv_import")
        if c.get("teacher"):
            teacher = User.objects.get(pk=c["teacher"]["id"])
            a = TeacherAssignment.objects.create(teacher=teacher, student=user, created_by=admin)
            audit("admin.teacher_assigned", actor=admin, target=a, request=request, source="csv_import")
        if c.get("circle"):
            m, r = membership.join(Circle.objects.get(pk=c["circle"]["id"]), user, admin)  # same capacity checks
            audit("admin.circle_member_added", actor=admin, target=m, request=request, circle=m.circle_id, student=user.pk,
                  source="csv_import", **r)
    return user


class StudentImport(APIView):
    """POST multipart {file, dry_run=true|false}. users.create (+ teachers.assign / circles.manage when those columns
    are used). GET ?template=1: the UTF-8 template."""

    permission_classes = [IsAdminRole]
    admin_perm = "users.create"
    parser_classes = [MultiPartParser]

    def get(self, request):
        resp = HttpResponse("﻿" + TEMPLATE_NOTE + "\r\n", content_type="text/csv; charset=utf-8")
        resp["Content-Disposition"] = 'attachment; filename="halqa-students-template.csv"'
        return resp

    def post(self, request):
        from .views import send_setup_email

        dry = str(request.data.get("dry_run", "true")).lower() not in ("false", "0", "no")
        report = validate(read_csv(request.FILES.get("file")), request.user)
        if dry:
            return Response({"dry_run": True, **report})
        started = _time.monotonic()
        created = []
        for row in report["rows"]:
            if row["status"] != "valid":
                row["result"] = "skipped"
                continue
            try:
                row["user"] = create_row(row, request.user, request).pk
                row["result"] = "created"
                created.append(row)
            except IntegrityError:  # the email was taken between validation and now
                row["result"], row["status"], row["errors"] = "failed", "duplicate", ["البريد مستخدم لحساب موجود."]
            except MembershipError as e:  # e.g. the circle filled up meanwhile: this row only, nothing half-created
                row["result"], row["status"], row["errors"] = "failed", "error", [str(e.detail)]
            except Exception:  # noqa: BLE001
                log.exception("student_import_row_failed", extra={"line": row["line"]})
                row["result"], row["status"], row["errors"] = "failed", "error", ["تعذّر إنشاء هذا الصف."]
        for row in created:
            if _time.monotonic() - started > EMAIL_BUDGET_SECONDS:
                row["email"] = "pending"
                continue
            row["email"] = "sent" if send_setup_email(User.objects.get(pk=row["user"]), request.user, request) else "failed"
        counts = {k: sum(1 for x in report["rows"] if x.get("result") == k) for k in ("created", "skipped", "failed")}
        emails = {k: sum(1 for x in created if x.get("email") == k) for k in ("sent", "failed", "pending")}
        audit("admin.students_imported", actor=request.user, request=request, rows=report["summary"]["total"], **counts,
              emails=emails, filename=str(getattr(request.FILES.get("file"), "name", ""))[:100])
        return Response({"dry_run": False, **report, "result": {**counts, "emails": emails}})
