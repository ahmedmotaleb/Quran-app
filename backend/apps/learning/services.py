from django.db import transaction

from apps.core.exceptions import ApiError

from .models import ASSIGNMENT_TRANSITIONS, Assignment, AssignmentEvent


def transition(assignment: Assignment, to_status: str, *, actor) -> Assignment:
    """Move an assignment along its allowed status graph and record who did it."""
    with transaction.atomic():
        a = Assignment.objects.select_for_update().get(pk=assignment.pk)
        if to_status == a.status:
            return a
        if to_status not in ASSIGNMENT_TRANSITIONS.get(a.status, set()):
            raise ApiError("invalid_transition", "لا يمكن نقل المهمة إلى هذه الحالة.", 409)
        AssignmentEvent.objects.create(assignment=a, actor=actor, from_status=a.status, to_status=to_status)
        a.status = to_status
        a.save(update_fields=["status", "updated_at"])
        return a
