"""M4: real download/upload, preview, explicit restore and mobile forms."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8876"
ARTIFACTS = Path(__file__).resolve().parents[1] / "test-results"
PASSWORD = "browser-backup-fixture-only"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1100}, reduced_motion="reduce", accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.get_by_label("管理员口令").fill("admin-test-credential-only-123456")
    page.get_by_role("button", name="进入控制台").click()
    expect(page.get_by_role("heading", name="搜索概览.")).to_be_visible()
    assert page.request.post(f"{BASE}/api/keys", data={"provider": "tavily", "label": "Migration original", "account": "fixture", "keys": ["browser-backup-key-fixture-123456"]}).status == 201
    page.get_by_role("button", name="备份与迁移", exact=True).click()
    page.get_by_label("设置备份密码", exact=True).fill(PASSWORD)
    page.get_by_label("再次输入备份密码", exact=True).fill("mismatched-password-fixture")
    page.get_by_role("button", name="下载加密备份").click()
    expect(page.get_by_role("alert")).to_contain_text("不一致")
    page.get_by_label("再次输入备份密码", exact=True).fill(PASSWORD)
    with page.expect_download() as download_info:
        page.get_by_role("button", name="下载加密备份").click()
    archive = ARTIFACTS / "browser-fixture-backup.sab"
    download_info.value.save_as(str(archive))
    expect(page.get_by_label("设置备份密码", exact=True)).to_have_value("")
    assert b"browser-backup-key-fixture" not in archive.read_bytes()
    assert page.request.post(f"{BASE}/api/keys", data={"provider": "exa", "label": "After backup", "account": "fixture", "keys": ["after-backup-fixture-key-123456"]}).status == 201
    page.get_by_label("选择备份文件").set_input_files(str(archive))
    page.get_by_label("输入备份密码", exact=True).fill("incorrect-backup-password")
    page.get_by_role("button", name="预览备份").click()
    expect(page.get_by_role("alert")).to_contain_text("密码不正确")
    assert len(page.request.get(f"{BASE}/api/keys").json()) == 2
    page.get_by_label("输入备份密码", exact=True).fill(PASSWORD)
    page.get_by_role("button", name="预览备份").click()
    restore = page.get_by_role("button", name="确认替换并恢复")
    expect(restore).to_be_visible()
    expect(restore).to_be_disabled()
    expect(page.get_by_text("Tavily 1", exact=True)).to_be_visible()
    page.screenshot(path=str(ARTIFACTS / "backups-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    restore.scroll_into_view_if_needed()
    expect(restore).to_be_in_viewport()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(ARTIFACTS / "backups-mobile.png"), full_page=True)
    page.get_by_role("checkbox", name="我已备份当前数据", exact=False).check()
    restore.click()
    expect(page.get_by_role("status")).to_contain_text("恢复完成")
    assert len(page.request.get(f"{BASE}/api/keys").json()) == 1
    expect(page.get_by_label("输入备份密码", exact=True)).to_have_value("")
    page.reload()
    expect(page.get_by_role("heading", name="搜索概览.")).to_be_visible()
    assert not errors, errors
    browser.close()
print("Encrypted download/upload, validation recovery, explicit restore, retained admin login and mobile layout passed")
