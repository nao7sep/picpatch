"""Shared failures at the inference adapter boundary."""
class Cancelled(Exception):
    pass


class InvalidEditInput(Exception):
    pass


class BackendUnavailable(Exception):
    def __init__(self, message, reason=None):
        super().__init__(message)
        self.reason = reason
