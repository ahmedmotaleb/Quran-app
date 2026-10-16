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


def _media_url(media, user, request):
    from apps.media import services as media_services

    if media is None or not media_services.can_read(user, media):
        return None
    return media_services.read_url(media, request)


def submission_out(s, user, request) -> dict:
    """Submission + feedback as the API returns them. Audio URLs only for people allowed to hear them."""
    a = s.assignment
    fb = getattr(s, "feedback", None)
    out = {
        "id": s.id, "assignment": a.id, "assignment_title": a.title, "kind": a.kind, "surah": a.surah, "ayah_from": a.ayah_from,
        "ayah_to": a.ayah_to, "student": s.student_id, "student_name": s.student.full_name, "attempt": s.attempt,
        "duration_seconds": s.duration_seconds, "created_at": s.created_at.isoformat(), "audio": _media_url(s.media, user, request),
        "audio_deleted": s.media.state == "deleted",
        "feedback": None,
    }
    if fb is not None:
        out["feedback"] = {
            "id": fb.id, "teacher": fb.teacher_id, "teacher_name": fb.teacher.full_name, "created_at": fb.created_at.isoformat(),
            "score_hifz": fb.score_hifz, "score_tajweed": fb.score_tajweed, "score_fluency": fb.score_fluency,
            "decision": fb.decision, "general": fb.general, "needs_review": fb.needs_review, "next_step": fb.next_step,
            "notes": [{"at_seconds": n.at_seconds, "text": n.text, "category": n.category} for n in fb.notes.all()],
            "voice": _media_url(fb.voice, user, request),
            "voice_seconds": fb.voice.duration_seconds if fb.voice else None,
        }
    return out
