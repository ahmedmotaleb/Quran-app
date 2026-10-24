"""Support tickets (PROMPT 49).

Requesters (students, teachers, parents) see only their own tickets and only public messages. Staff need
`support.view` to read (internal notes included) and `support.manage` to reply, add internal notes, assign and change
the state. Every change is audited. A screenshot may be attached (images only, re-encoded; see media.services);
recitation recordings or any other file cannot be attached.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.accounts.admin_access import has
from apps.accounts.models import Role, User
from apps.accounts.permissions import HasRole, IsAdminRole
from apps.core.admin_views import _page
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.media.models import MediaObject
from apps.media.services import store_support_image
from apps.notifications.services import after_commit

from .models import Ticket, TicketMessage

S = Ticket.Status
USER_CATEGORIES = [c for c in Ticket.Category if c != Ticket.Category.PAYMENT]  # payments do not exist yet
LINK = "/#/support"


class IsRequesterRole(HasRole):
    roles = (Role.STUDENT, Role.TEACHER, Role.PARENT)


def invalid(field: str, msg: str) -> ApiError:
    return ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {field: [msg]})


def clean_text(data, field: str, max_len: int, label: str) -> str:
    v = str(data.get(field) or "").strip()
    if not v:
        raise invalid(field, f"اكتب {label}.")
    if len(v) > max_len:
        raise invalid(field, f"الحد الأقصى {max_len} حرف.")
    return v


def attachment_of(request) -> MediaObject | None:
    """Only a new image uploaded in this same request. An id of existing media (a recitation, a lesson file, someone
    else's upload) is never accepted."""
    if "attachment" in request.data or "media" in request.data:
        raise invalid("image", "أرفق الصورة نفسها؛ لا يمكن إرفاق تسجيلات أو ملفات أخرى.")
    f = request.FILES.get("image")
    return store_support_image(owner=request.user, upload=f) if f else None


def media_out(m: MediaObject | None) -> dict | None:
    return {"id": str(m.id), "content_type": m.content_type} if m and m.state == MediaObject.State.VALIDATED else None


def person(u: User | None) -> dict | None:
    return {"id": u.pk, "name": u.full_name, "role": u.role} if u else None


def msg_out(m: TicketMessage, *, staff: bool) -> dict:
    out = {"id": m.pk, "body": m.body, "created_at": m.created_at.isoformat(), "attachment": media_out(m.attachment),
           "from_staff": m.author_id != m.ticket.requester_id}  # staff = anyone answering someone else's request
    # The requester sees «فريق الدعم», never which admin answered.
    out["author"] = person(m.author) if staff else (None if out["from_staff"] else person(m.author))
    if staff:
        out["internal"] = m.internal
    return out


def ticket_out(t: Ticket, *, staff: bool, messages: bool = False, viewer=None) -> dict:
    out = {"id": t.pk, "category": t.category, "category_label": t.get_category_display(), "subject": t.subject, "status": t.status,
           "status_label": t.get_status_display(), "created_at": t.created_at.isoformat(), "last_activity_at": t.last_activity_at.isoformat(),
           "resolved_at": t.resolved_at.isoformat() if t.resolved_at else None}
    if staff:
        out["requester"] = person(t.requester)
        if viewer is not None and has(viewer, "users.view_contact"):
            out["requester"]["email"] = t.requester.email
        out["assignee"] = person(t.assignee)
    if messages:
        qs = t.messages.select_related("author", "attachment")
        if not staff:
            qs = qs.filter(internal=False)
        out["messages"] = [msg_out(m, staff=staff) for m in qs]
    return out


def set_status(t: Ticket, status: str, now) -> None:
    t.status = status
    if status == S.RESOLVED:
        t.resolved_at = now
    elif status == S.CLOSED:
        t.closed_at = now
    else:
        t.resolved_at = t.closed_at = None


class WriteThrottled:
    """New tickets and replies count against the «support» rate; reading does not."""

    throttle_scope = "support"

    def get_throttles(self):
        return [ScopedRateThrottle()] if self.request.method == "POST" else []


# ---- Requester ----------------------------------------------------------------------------------
class MyTickets(WriteThrottled, APIView):
    permission_classes = [IsAuthenticated, IsRequesterRole]

    def get(self, request):
        qs = Ticket.objects.filter(requester=request.user)
        return Response({"results": [ticket_out(t, staff=False) for t in qs[:100]],
                         "categories": [{"value": c.value, "label": c.label} for c in USER_CATEGORIES]})

    def post(self, request):
        category = str(request.data.get("category") or "")
        if category not in [c.value for c in USER_CATEGORIES]:
            raise invalid("category", "اختر نوع الطلب.")
        subject = clean_text(request.data, "subject", 160, "عنوانًا مختصرًا")
        body = clean_text(request.data, "message", 4000, "تفاصيل طلبك")
        with transaction.atomic():
            image = attachment_of(request)
            t = Ticket.objects.create(requester=request.user, category=category, subject=subject)
            TicketMessage.objects.create(ticket=t, author=request.user, body=body, attachment=image)
            audit("support.ticket_created", actor=request.user, target=t, request=request, category=category, attachment=bool(image))
        return Response(ticket_out(t, staff=False, messages=True), status=201)


def own_ticket(request, pk) -> Ticket:
    # Someone else's ticket is a 404, the same as a missing one (no hint that it exists).
    return get_object_or_404(Ticket, pk=pk, requester=request.user)


class MyTicketDetail(APIView):
    permission_classes = [IsAuthenticated, IsRequesterRole]

    def get(self, request, pk):
        return Response(ticket_out(own_ticket(request, pk), staff=False, messages=True))


class MyTicketReply(WriteThrottled, APIView):
    permission_classes = [IsAuthenticated, IsRequesterRole]

    def post(self, request, pk):
        body = clean_text(request.data, "message", 4000, "ردّك")
        with transaction.atomic():
            t = Ticket.objects.select_for_update().get(pk=own_ticket(request, pk).pk)
            if t.status == S.CLOSED:
                raise ApiError("ticket_closed", "هذا الطلب مغلق. افتح طلبًا جديدًا إن احتجت.", 409)
            image = attachment_of(request)
            TicketMessage.objects.create(ticket=t, author=request.user, body=body, attachment=image)
            now = timezone.now()
            if t.status in (S.WAITING_USER, S.RESOLVED):  # the requester answered: back to the team
                set_status(t, S.OPEN, now)
            t.last_activity_at = now
            t.save(update_fields=["status", "resolved_at", "closed_at", "last_activity_at", "updated_at"])
            audit("support.user_replied", actor=request.user, target=t, request=request, attachment=bool(image))
        return Response(ticket_out(t, staff=False, messages=True), status=201)


class MyTicketClose(APIView):
    permission_classes = [IsAuthenticated, IsRequesterRole]

    def post(self, request, pk):
        with transaction.atomic():
            t = Ticket.objects.select_for_update().get(pk=own_ticket(request, pk).pk)
            if t.status != S.CLOSED:
                set_status(t, S.CLOSED, timezone.now())
                t.last_activity_at = timezone.now()
                t.save(update_fields=["status", "resolved_at", "closed_at", "last_activity_at", "updated_at"])
                audit("support.closed_by_user", actor=request.user, target=t, request=request)
        return Response(ticket_out(t, staff=False, messages=True))


# ---- Staff --------------------------------------------------------------------------------------
class AdminTickets(APIView):
    """GET ?status=open|in_progress|waiting_user|resolved|closed|active &category &assignee=<id>|me|none &q"""

    permission_classes = [IsAdminRole]
    admin_perm = "support.view"

    def get(self, request):
        qs = Ticket.objects.select_related("requester", "assignee")
        p = request.query_params
        st = p.get("status", "active")
        if st == "active":
            qs = qs.exclude(status__in=[S.RESOLVED, S.CLOSED])
        elif st in S.values:
            qs = qs.filter(status=st)
        elif st != "all":
            raise invalid("status", "حالة غير معروفة.")
        if p.get("category"):
            qs = qs.filter(category=p["category"])
        a = p.get("assignee")
        if a == "me":
            qs = qs.filter(assignee=request.user)
        elif a == "none":
            qs = qs.filter(assignee__isnull=True)
        elif a:
            qs = qs.filter(assignee_id=int(a) if a.isdigit() else 0)
        if p.get("q"):
            q = p["q"].strip()[:100]
            qs = qs.filter(Q(subject__icontains=q) | Q(requester__full_name__icontains=q) | (Q(pk=int(q)) if q.isdigit() else Q()))
        return _page(self, request, qs, lambda t: ticket_out(t, staff=True, viewer=request.user))


class AdminTicketCounts(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = "support.view"

    def get(self, request):
        c = dict(Ticket.objects.values_list("status").annotate(n=Count("id")))
        return Response({**{s: c.get(s, 0) for s in S.values}, "unassigned_open": Ticket.objects.filter(
            status__in=[S.OPEN, S.IN_PROGRESS], assignee__isnull=True).count()})


class AdminSupportStaff(APIView):
    """Admins who may be assigned (they can read tickets)."""

    permission_classes = [IsAdminRole]
    admin_perm = "support.view"

    def get(self, request):
        from apps.accounts.admin_access import admin_users

        admins = admin_users().select_related("admin_profile").order_by("full_name")
        return Response({"results": [{"id": u.pk, "name": u.full_name} for u in admins if has(u, "support.view")]})


class AdminTicketDetail(APIView):
    """GET (support.view) · PATCH {status?, assignee?} (support.manage)"""

    permission_classes = [IsAdminRole]
    admin_perm = "support.view"

    def get(self, request, pk):
        t = get_object_or_404(Ticket.objects.select_related("requester", "assignee"), pk=pk)
        return Response(ticket_out(t, staff=True, messages=True, viewer=request.user))

    def patch(self, request, pk):
        from apps.accounts.admin_access import require

        require(request.user, "support.manage")
        with transaction.atomic():
            t = get_object_or_404(Ticket.objects.select_for_update(of=("self",)), pk=pk)
            changes, now = {}, timezone.now()
            if "status" in request.data:
                st = str(request.data["status"])
                if st not in S.values:
                    raise invalid("status", "حالة غير معروفة.")
                if st != t.status:
                    changes["status"] = [t.status, st]
                    set_status(t, st, now)
            if "assignee" in request.data:
                a = request.data["assignee"]
                new = None
                if a not in (None, ""):
                    from apps.accounts.admin_access import admin_users

                    new = admin_users().filter(pk=a).first() if str(a).isdigit() else None
                    if new is None or not has(new, "support.view"):
                        raise invalid("assignee", "اختر مسؤولًا لديه صلاحية طلبات الدعم.")
                if (new.pk if new else None) != t.assignee_id:
                    changes["assignee"] = [t.assignee_id, new.pk if new else None]
                    t.assignee = new
            if changes:
                t.last_activity_at = now
                t.save()
                audit("support.ticket_updated", actor=request.user, target=t, request=request, **changes)
                if changes.get("status", [None, None])[1] == S.RESOLVED:
                    after_commit(t.requester, "support_resolved", "تم حل طلب الدعم", t.subject, link=LINK,
                                 dedupe=f"support_resolved:{t.pk}:{now.timestamp():.0f}", data={"ticket": t.pk})
        t.refresh_from_db()
        return Response(ticket_out(t, staff=True, messages=True, viewer=request.user))


class AdminTicketReply(APIView):
    """POST {message, internal?, status?} + optional image (support.manage). A public reply notifies the requester and,
    unless a status is given, waits for their answer (waiting_user). An internal note changes nothing for them."""

    permission_classes = [IsAdminRole]
    admin_perm = "support.manage"

    def post(self, request, pk):
        body = clean_text(request.data, "message", 4000, "الرد")
        internal = str(request.data.get("internal", "")).lower() in ("1", "true", "yes", "on")
        st = request.data.get("status") or (None if internal else S.WAITING_USER)
        if st is not None and st not in S.values:
            raise invalid("status", "حالة غير معروفة.")
        with transaction.atomic():
            t = get_object_or_404(Ticket.objects.select_for_update(of=("self",)), pk=pk)
            image = attachment_of(request)
            m = TicketMessage.objects.create(ticket=t, author=request.user, body=body, internal=internal, attachment=image)
            now, old = timezone.now(), t.status
            if st and st != t.status:
                set_status(t, st, now)
            if t.assignee_id is None:
                t.assignee = request.user  # whoever answers first owns it until reassigned
            t.last_activity_at = now
            t.save()
            audit("support.note_added" if internal else "support.replied", actor=request.user, target=t, request=request,
                  message=m.pk, status=[old, t.status] if old != t.status else None, attachment=bool(image))
            if not internal:
                resolved = t.status == S.RESOLVED and old != S.RESOLVED
                after_commit(t.requester, "support_resolved" if resolved else "support_reply",
                             "تم حل طلب الدعم" if resolved else "ردّ جديد على طلب الدعم", t.subject, link=LINK,
                             dedupe=f"support:{t.pk}:{m.pk}", data={"ticket": t.pk})
        return Response(ticket_out(t, staff=True, messages=True, viewer=request.user), status=201)
