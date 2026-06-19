"""Company-name normalization for cache keys.

A company input (name or domain) is normalized into a stable cache-key
string: whitespace stripped, lowercased, a leading ``http://``/``https://``
scheme removed, a leading ``www.`` removed, and a trailing ``/`` dropped.
"""


def normalize_company(s: str) -> str:
    s = s.strip().lower()
    if s.startswith("https://"):
        s = s[len("https://") :]
    elif s.startswith("http://"):
        s = s[len("http://") :]
    if s.startswith("www."):
        s = s[len("www.") :]
    if s.endswith("/"):
        s = s[:-1]
    return s
