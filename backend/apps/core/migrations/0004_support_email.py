"""Owner decision (16 October 2026): support mail goes to halqa.app.eg@gmail.com.

Only the untouched placeholder is replaced; an address an admin already saved is kept.
"""

from django.db import migrations, models

OLD, NEW = "support@halqa.app", "halqa.app.eg@gmail.com"


def forward(apps, schema_editor):
    apps.get_model("core", "AppSettings").objects.filter(support_email=OLD).update(support_email=NEW)


def backward(apps, schema_editor):
    apps.get_model("core", "AppSettings").objects.filter(support_email=NEW).update(support_email=OLD)


class Migration(migrations.Migration):
    dependencies = [("core", "0003_review_engine")]

    operations = [
        migrations.AlterField(
            model_name="appsettings",
            name="support_email",
            field=models.EmailField(default=NEW, max_length=254),
        ),
        migrations.RunPython(forward, backward),
    ]
