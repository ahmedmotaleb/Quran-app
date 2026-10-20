"""Hourly: book circle members into upcoming sessions they are missing (e.g. a seat freed up, or a session added
outside the admin screen). Safe to run repeatedly."""
from django.core.management.base import BaseCommand

from apps.scheduling.membership import sync_circle
from apps.scheduling.models import Circle


class Command(BaseCommand):
    help = "Book active circle members into upcoming circle sessions."

    def handle(self, **_):
        total = 0
        for c in Circle.objects.filter(state=Circle.State.PUBLISHED, members__active=True).distinct():
            total += sync_circle(c)["booked"]
        self.stdout.write(f"circle members booked: {total}")
