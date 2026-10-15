"""Password hashing sized for small containers (pack prompt 25 finding).

Django's Argon2 defaults use ~100 MB of memory per hash. A 512 MB Cloud Run instance serves 8 requests at once
(2 workers x 4 threads), so a burst of sign-ins could exhaust memory. OWASP's recommended Argon2id setting
(m=19 MiB, t=2, p=1) keeps each hash at ~19 MB. Same algorithm name, so stored hashes still verify and Django
re-hashes them with these parameters at the user's next successful sign-in.
"""
from django.contrib.auth.hashers import Argon2PasswordHasher


class SmallArgon2PasswordHasher(Argon2PasswordHasher):
    time_cost = 2
    memory_cost = 19 * 1024  # KiB
    parallelism = 1
