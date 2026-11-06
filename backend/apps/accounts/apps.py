from django.apps import AppConfig


class AccountsConfig(AppConfig):
    name = "apps.accounts"
    label = "accounts"

    def ready(self):
        from django.db.models.signals import post_save

        from .models import TeacherAssignment

        def assigned(sender, instance, created, **kw):
            # Any path that links a student to a teacher (student record, bulk action, «اختر معلمك» review) closes the
            # student's open teacher request and stops the «اختر معلمك» reminders.
            if instance.active and created:
                from django.db import transaction

                from .teacher_requests import on_assigned

                transaction.on_commit(lambda: on_assigned(instance.student, instance.teacher))

        post_save.connect(assigned, sender=TeacherAssignment, dispatch_uid="teacher_request_on_assigned")
