"""Error model (PROJECT.md §6.8, §8.4) and consumer failure classes (§6.5, steering/quality.md)."""

import hashlib
import re
import traceback
from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar

_CODE = re.compile(r"^[A-Z][A-Z0-9_]*$")


@dataclass(frozen=True, slots=True)
class ErrorDetail:
    """One field-level problem (§8.2 ``details[]``)."""

    field: str
    issue: str


class DomainError(Exception):
    """Business failure with a stable §8.4 code; never carries secrets or raw input values."""

    http_status: ClassVar[int] = 409

    def __init__(self, code: str, message: str, details: tuple[ErrorDetail, ...] = ()) -> None:
        if not _CODE.fullmatch(code):
            raise ValueError("invalid error code")
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class ValidationFailedError(DomainError):
    """422 (VALIDATION_ERROR, ...)."""

    http_status = 422


class UnauthorizedError(DomainError):
    """401 (UNAUTHORIZED, ...)."""

    http_status = 401


class ForbiddenError(DomainError):
    """403 (FORBIDDEN, TENANT_SUSPENDED, ...)."""

    http_status = 403


class NotFoundError(DomainError):
    """404: absent or owned by another tenant."""

    http_status = 404


class ConflictError(DomainError):
    """409 (CONFLICT, IDEMPOTENCY_KEY_REUSED, ...)."""

    http_status = 409


class TransientError(Exception):
    """Retryable: timeout, 5xx, circuit open, connection reset, write conflict."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class PermanentError(Exception):
    """Never succeeds on retry: dependency 4xx (not 408/429), business rule violation."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class PoisonMessageError(Exception):
    """Undeserializable or schema-invalid message, unknown major schemaVersion."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class FailureKind(StrEnum):
    """TRANSIENT → retry tiers then DLQ; PERMANENT and POISON → DLQ immediately."""

    TRANSIENT = "TRANSIENT"
    PERMANENT = "PERMANENT"
    POISON = "POISON"


@dataclass(frozen=True, slots=True)
class ClassifiedFailure:
    """Classification result."""

    kind: FailureKind
    code: str


def classify_failure(error: BaseException) -> ClassifiedFailure:
    """Unknown errors are TRANSIENT: a bug gets the bounded retry budget (NFR-10), then the DLQ."""
    match error:
        case PoisonMessageError():
            return ClassifiedFailure(FailureKind.POISON, error.code)
        case PermanentError():
            return ClassifiedFailure(FailureKind.PERMANENT, error.code)
        case DomainError():
            return ClassifiedFailure(FailureKind.PERMANENT, error.code)
        case TransientError():
            return ClassifiedFailure(FailureKind.TRANSIENT, error.code)
        case _:
            return ClassifiedFailure(FailureKind.TRANSIENT, "INTERNAL_ERROR")


def describe_error(error: BaseException, max_length: int = 500) -> str:
    """Log-safe one line: class, code, message; no stack."""
    code = getattr(error, "code", None)
    text = f"{type(error).__name__}{f'[{code}]' if isinstance(code, str) else ''}: {error}"
    return text if len(text) <= max_length else text[: max_length - 1] + "…"


_OWN_ERRORS = (DomainError, TransientError, PermanentError, PoisonMessageError)


def dead_letter_message(error: BaseException) -> str:
    """The ``x-aegis-error-message`` value (§6.4, FR-MSG-02).

    Full description only for the platform's own error types (messages written by our code); any other exception
    (pydantic, driver, parser) may embed input values, so only its type travels.
    """
    if isinstance(error, _OWN_ERRORS):
        return describe_error(error)
    return f"{type(error).__name__} (message withheld)"


_STACK_HASH_FRAMES = 10


def stack_hash(error: BaseException) -> str:
    """Groups identical failures for the dead-letter registry (§6.4 ``x-aegis-error-stack-hash``, FR-MSG-02).

    First 16 hex of SHA-256 over the error's qualified class name and its innermost traceback frames (file + function,
    no line numbers). The message is excluded because it may vary per delivery.
    """
    kind = type(error)
    frames = traceback.extract_tb(error.__traceback__)[-_STACK_HASH_FRAMES:]
    material = "\n".join([f"{kind.__module__}.{kind.__qualname__}", *(f"{f.filename}:{f.name}" for f in frames)])
    return hashlib.sha256(material.encode()).hexdigest()[:16]
