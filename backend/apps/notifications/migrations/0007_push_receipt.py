from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("notifications", "0006_notification_push_outbox")]

    operations = [
        migrations.AddField("pushsubscription", "last_receipt_at", models.DateTimeField(blank=True, null=True)),
        migrations.AddField("pushsubscription", "last_receipt", models.CharField(blank=True, default="", max_length=60)),
    ]
