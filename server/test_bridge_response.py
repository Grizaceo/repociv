from http.client import HTTPMessage
from unittest.mock import Mock

from server.bridge import BridgeHandler


def test_json_response_ignores_client_disconnect_during_write() -> None:
    handler = object.__new__(BridgeHandler)
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.headers = HTTPMessage()
    handler.wfile = Mock()
    handler.wfile.write.side_effect = BrokenPipeError

    handler._json({"ok": True}, record_usage=False)

    handler.send_response.assert_called_once_with(200)
    handler.wfile.write.assert_called_once()
