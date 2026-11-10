from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("notifications", "0005_reminder_settings")]

    operations = [
        migrations.AddField("notification", "push_status", models.CharField(blank=True, default="", max_length=10)),
        migrations.AddField("notification", "push_attempts", models.PositiveSmallIntegerField(default=0)),
        migrations.AddField("notification", "push_at", models.DateTimeField(blank=True, null=True)),
        migrations.AddField("notification", "push_error", models.CharField(blank=True, default="", max_length=20)),
        migrations.AddField("notification", "push_targets", models.JSONField(blank=True, default=list)),
        migrations.AddIndex("notification", models.Index(fields=["push_status"], name="notificatio_push_st_d62c89_idx")),
    ]
