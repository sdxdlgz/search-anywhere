"""H3/H5: retention policy, preview/confirmation, errors, persisted settings and mobile UI."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8876"
ARTIFACTS = Path(__file__).resolve().parents[1] / "test-results"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1100}, reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.get_by_label("管理员口令").fill("admin-test-credential-only-123456")
    page.get_by_role("button", name="进入控制台").click()
    expect(page.get_by_role("heading", name="搜索概览.")).to_be_visible()
    assert page.request.post(f"{BASE}/api/keys", data={"provider": "tavily", "label": "Retention fixture", "account": "test only", "keys": ["retention-browser-fixture-key-123456"]}).status == 201
    profile = page.request.get(f"{BASE}/api/profiles").json()[0]
    profile["modes"] = {"exa": None, "parallel": None, "tavily": "basic", "anysearch": None, "keenable": None}
    assert page.request.put(f"{BASE}/api/profiles/{profile['id']}", data=profile).status == 200
    search = page.request.post(f"{BASE}/api/search", data={"query": "retention browser evidence", "profile": profile["id"]})
    assert search.status == 200
    collection = search.json()["collection_id"]
    page.get_by_role("button", name="备份与迁移", exact=True).click()
    section = page.get_by_role("region", name="历史数据清理")
    expect(section.get_by_label("启用自动清理")).to_be_checked()
    expect(section.get_by_label("自动保留天数")).to_have_value("7")
    section.get_by_label("启用自动清理").uncheck()
    section.get_by_label("自动保留天数").fill("30")
    section.get_by_role("button", name="保存清理策略").click()
    expect(section.get_by_role("status")).to_contain_text("已保存")
    page.reload()
    page.get_by_role("button", name="备份与迁移", exact=True).click()
    expect(section.get_by_label("启用自动清理")).not_to_be_checked()
    expect(section.get_by_label("自动保留天数")).to_have_value("30")
    section.get_by_role("button", name="预览清理范围").click()
    expect(section.get_by_text("当前没有符合条件的内容。")).to_be_visible()
    section.get_by_label("手动清理范围").select_option("0")
    section.get_by_role("button", name="预览清理范围").click()
    confirm = section.get_by_role("button", name="确认清理历史内容")
    expect(confirm).to_be_disabled()
    before = page.request.get(f"{BASE}/api/keys").json()
    page.screenshot(path=str(ARTIFACTS / "retention-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    confirm.scroll_into_view_if_needed()
    expect(confirm).to_be_in_viewport()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(ARTIFACTS / "retention-mobile.png"), full_page=True)
    # A real concurrent write invalidates the preview; nothing is silently deleted.
    assert page.request.put(f"{BASE}/api/retention", data={"enabled": False, "days": 30}).status == 200
    section.get_by_label("确认删除以上历史内容", exact=False).check()
    confirm.click()
    expect(section.get_by_role("alert")).to_contain_text("数据已变化")
    assert page.request.post(f"{BASE}/api/results", data={"collection_id": collection}).status == 200
    section.get_by_role("button", name="预览清理范围").click()
    section.get_by_label("确认删除以上历史内容", exact=False).check()
    confirm.click()
    expect(section.get_by_role("status")).to_contain_text("已清理")
    assert page.request.post(f"{BASE}/api/results", data={"collection_id": collection}).status == 404
    assert page.request.get(f"{BASE}/api/logs").json() == []
    after = page.request.get(f"{BASE}/api/keys").json()
    for left, right in zip(before, after):
        for field in ["id", "calls", "successes", "metering", "usage", "masked"]:
            assert left[field] == right[field], field
    section.get_by_label("启用自动清理").check()
    section.get_by_label("自动保留天数").fill("7")
    section.get_by_role("button", name="保存清理策略").click()
    expect(section.get_by_role("status")).to_contain_text("已保存")
    assert page.request.get(f"{BASE}/api/retention").json()["policy"] == {"enabled": True, "days": 7}
    expect(section.get_by_role("status")).not_to_be_visible(timeout=8000)
    assert not errors, errors
    browser.close()
print("Retention policy, preview/confirmation, stale-preview recovery, evidence expiry, preserved usage and desktop/mobile passed")
