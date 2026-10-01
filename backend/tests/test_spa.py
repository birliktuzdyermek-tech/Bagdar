"""Раздача собранного фронтенда: файлы из dist отдаются, выход за dist запрещён."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from bagdar.api.app import mount_spa


@pytest.fixture()
def spa(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>spa</html>", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("SECRET", encoding="utf-8")
    app = FastAPI()
    mount_spa(app, dist)
    return TestClient(app)


def test_serves_files_and_index(spa):
    assert spa.get("/").text == "<html>spa</html>"
    assert spa.get("/favicon.svg").text == "<svg/>"
    assert spa.get("/assets/app.js").text == "console.log(1)"
    assert spa.get("/some/client/route").text == "<html>spa</html>"


@pytest.mark.parametrize("path", [
    "/..%2Fsecret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/..%5Csecret.txt",
    "/assets/..%2F..%2Fsecret.txt",
])
def test_no_path_traversal(spa, path):
    r = spa.get(path)
    assert "SECRET" not in r.text


def test_no_absolute_path(spa, tmp_path):
    r = spa.get("/" + str(tmp_path / "secret.txt").replace("\\", "/"))
    assert "SECRET" not in r.text
