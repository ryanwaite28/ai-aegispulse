"""Readiness check type, kept framework-free so data and broker modules can build checks without FastAPI."""

from collections.abc import Awaitable, Callable

Check = Callable[[], Awaitable[None]]
