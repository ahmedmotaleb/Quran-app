"""Hourly: expire lapsed waiting-list offers and offer free seats; expire unused make-up credits."""
from django.core.management.base import BaseCommand

from apps.scheduling import makeup, waitlist


class Command(BaseCommand):
    help = "Waiting-list offers and make-up credit expiry."

    def handle(self, **_):
        offers = waitlist.tick_all()
        expired = makeup.expire_all()
        self.stdout.write(f"waitlist offers: {offers}; make-up credits expired: {expired}")
