from server import locks


def test_get_lock_returns_same_instance_for_same_key():
    locks._reset()
    a = locks.get_lock("x")
    b = locks.get_lock("x")
    c = locks.get_lock("y")
    assert a is b
    assert a is not c


def test_hold_context_acquires_and_releases_lock():
    locks._reset()
    lock = locks.get_lock("z")
    assert lock.acquire(blocking=False) is True
    lock.release()
    with locks.hold("z"):
        assert lock.acquire(blocking=False) is True
        lock.release()
