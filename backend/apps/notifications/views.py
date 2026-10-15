from django.utils import timezone
from rest_framework import generics, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "kind", "title", "body", "link", "data", "read_at", "created_at"]


class NotificationList(generics.ListAPIView):
    """Newest first, paginated. `?unread=1` for unread only. Due session reminders are created on the way in."""

    serializer_class = NotificationSerializer

    def get_queryset(self):
        from .services import ensure_session_reminders

        ensure_session_reminders(self.request.user)
        qs = Notification.objects.filter(recipient=self.request.user).order_by("-created_at", "-id")
        if self.request.query_params.get("unread") == "1":
            qs = qs.filter(read_at__isnull=True)
        return qs


class UnreadCount(APIView):
    def get(self, request):
        from .services import ensure_session_reminders

        ensure_session_reminders(request.user)
        return Response({"unread": Notification.objects.filter(recipient=request.user, read_at__isnull=True).count()})


class NotificationRead(APIView):
    def post(self, request):
        ids = request.data.get("ids")
        qs = Notification.objects.filter(recipient=request.user, read_at__isnull=True)
        if isinstance(ids, list):
            qs = qs.filter(pk__in=[i for i in ids if isinstance(i, int)])
        return Response({"updated": qs.update(read_at=timezone.now())})
