"""TaskForge — minimal task queue with named heroes (demo city #2)."""
from __future__ import annotations

_FINISHED_STATUSES = {"done", "cancelled"}


class Task:
    def __init__(self, task_id: str, hero: str, title: str) -> None:
        self.task_id = task_id
        self.hero = hero  # stored lowercase; see the failing test
        self.title = title
        self.status = "open"

    def close(self, status: str = "done") -> None:
        if status not in _FINISHED_STATUSES:
            raise ValueError(f"unknown close status: {status!r}")
        self.status = status


class Board:
    """In-memory board keyed by task_id."""

    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}

    def add(self, task: Task) -> Task:
        if task.task_id in self._tasks:
            raise KeyError(f"duplicate task_id {task.task_id!r}")
        self._tasks[task.task_id] = task
        return task

    def by_hero(self, hero: str) -> list[Task]:
        """All open tasks assigned to a hero.

        BUG (demo): compares raw input against stored lowercase names, so
        `by_hero("Aria")` returns [] while the task is stored as "aria".
        """
        return [t for t in self._tasks.values() if t.hero == hero and t.status == "open"]