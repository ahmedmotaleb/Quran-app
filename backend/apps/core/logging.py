import contextvars
import json
import logging
from datetime import datetime, timezone

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# Never log these keys even if they appear in `extra`.
REDACT = {"password", "token", "authorization", "otp", "code", "secret", "key"}


class RequestIdFilter(logging.Filter):
    def filter(self, record):
        record.request_id = request_id_var.get()
        return True


class JsonFormatter(logging.Formatter):
    _std = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "request_id"}

    def format(self, record):
        out = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", "-"),
            "msg": record.getMessage(),
        }
        for k, v in vars(record).items():
            if k not in self._std and not k.startswith("_"):
                out[k] = "[redacted]" if k.lower() in REDACT else v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False, default=str)
