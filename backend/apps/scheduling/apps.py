from django.apps import AppConfig


class Config(AppConfig):
    name = "apps.scheduling"
    label = "scheduling"

    def ready(self):
        """15-minute reminders (reminders.py): whenever a session is created, moved or back to scheduled, or a booking
        is confirmed, set its T−15 alarm (or remind at once inside the last 15 minutes) after the change commits."""
        from django.db import transaction
        from django.db.models.signals import post_save, pre_save

        from .models import Booking, SessionOccurrence

        def remember(sender, instance, **kw):
            old = SessionOccurrence.objects.filter(pk=instance.pk).values("starts_at", "status").first() if instance.pk else None
            instance._reminder_before = old

        def occurrence_saved(sender, instance, created, **kw):
            old = getattr(instance, "_reminder_before", None)
            if created or old is None or old["starts_at"] != instance.starts_at or old["status"] != instance.status:
                from .reminders import session_changed

                transaction.on_commit(lambda: session_changed(instance))

        def booking_saved(sender, instance, created, **kw):
            if instance.status == Booking.Status.CONFIRMED:
                from .reminders import session_changed

                transaction.on_commit(lambda: session_changed(instance.occurrence))

        pre_save.connect(remember, sender=SessionOccurrence, dispatch_uid="reminder_remember")
        post_save.connect(occurrence_saved, sender=SessionOccurrence, dispatch_uid="reminder_occurrence")
        post_save.connect(booking_saved, sender=Booking, dispatch_uid="reminder_booking")
