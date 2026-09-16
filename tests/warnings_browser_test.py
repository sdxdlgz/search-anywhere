"""W6: results/log warning details, safe text rendering and mobile layout."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8876"
ARTIFACTS = Path(__file__).resolve().parents[1] / "test-results"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.get_by_label("管理员口令").fill("admin-test-credential-only-123456")
    page.get_by_role("button", name="进入控制台").click()
    expect(page.get_by_role("heading", name="搜索概览.")).to_be_visible()
    secret = "parallel-warning-browser-secret-123456"
    assert page.request.post(f"{BASE}/api/keys", data={"provider": "parallel", "label": "Warning fixture", "account": "fixture", "keys": [secret]}).status == 201
    profile = {"id": "warnings-check", "name": "警告检查", "modes": {"exa": None, "parallel": "advanced", "tavily": None, "anysearch": None, "keenable": None}, "max_results": 10, "per_provider_results": 40, "timeout_ms": 15000, "cache_ttl_seconds": 0, "parallel_transport": "api"}
    assert page.request.put(f"{BASE}/api/profiles/warnings-check", data=profile).status == 200
    page.get_by_role("button", name="刷新数据", exact=True).click()
    page.get_by_role("button", name="搜索测试", exact=True).click()
    page.get_by_label("搜索预设").select_option("warnings-check")
    page.get_by_label("你想搜索什么？").fill("parallel-warning-browser")
    page.get_by_role("button", name="开始搜索").click()
    expect(page.get_by_role("heading", name="融合结果")).to_be_visible()
    outcome = page.locator(".outcome")
    expect(outcome).to_contain_text("API key")
    outcome.locator("summary").click()
    expect(outcome.locator("details")).to_contain_text("Reducing max_results=40 to 20.")
    expect(outcome.locator("details")).to_contain_text("input_validation_warning")
    expect(outcome.locator("details")).to_contain_text("本身不代表正文抓取失败或免费额度受限")
    assert secret not in outcome.inner_text()
    assert outcome.locator("img").count() == 0
    assert page.evaluate("window.warningInjected === undefined")
    page.screenshot(path=str(ARTIFACTS / "warnings-results.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    outcome.locator("summary").scroll_into_view_if_needed()
    expect(outcome.locator("summary")).to_be_in_viewport()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(ARTIFACTS / "warnings-results-mobile.png"), full_page=True)
    page.set_viewport_size({"width": 1440, "height": 1050})
    page.get_by_label("你想搜索什么？").fill("尚未提交的新问题")
    with page.expect_request(lambda request: request.url.endswith('/api/fetch')) as fetch_request:
        page.get_by_role("button", name="读取正文", exact=False).first.click()
    assert fetch_request.value.post_data_json['objective'] == 'parallel-warning-browser'
    expect(page.get_by_role("heading", name="网页正文", exact=True)).to_be_visible()
    page.get_by_role("button", name="用量与日志", exact=True).click()
    page.get_by_role("button", name="parallel-warning-browser", exact=False).click()
    detail = page.locator(".request-detail")
    detail.locator("summary").click()
    expect(detail.locator("details")).to_contain_text("Reducing max_results=40 to 20.")
    assert secret not in page.request.get(f"{BASE}/api/logs").text()
    page.set_viewport_size({"width": 390, "height": 844})
    detail.locator("summary").scroll_into_view_if_needed()
    expect(detail.locator("summary")).to_be_in_viewport()
    assert detail.locator("details").bounding_box()["width"] >= 160
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(ARTIFACTS / "warnings-mobile.png"), full_page=True)
    page.set_viewport_size({"width": 1440, "height": 1050})
    page.reload()
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="用量与日志", exact=True).click()
    page.get_by_role("button", name="parallel-warning-browser", exact=False).click()
    page.locator(".request-detail summary").click()
    expect(page.locator(".request-detail details")).to_contain_text("Reducing max_results=40 to 20.")
    assert not errors, errors
    browser.close()
print("Warning result/log details, persistence, safe rendering and mobile layout passed")
