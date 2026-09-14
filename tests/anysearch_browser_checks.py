"""A1-A4 website-login acceptance with fake upstream credentials only."""
import re
from playwright.sync_api import expect


def check_anysearch_login(page, artifacts):
    base = 'http://127.0.0.1:8876'
    key = next(k for k in page.request.get(f'{base}/api/keys').json() if k['label'] == 'Browser AnySearch')
    calls = page.request.get(f'{base}/api/dashboard').json()['calls']
    row = page.locator('tr').filter(has=page.get_by_text('Browser AnySearch', exact=True))

    def open_login():
        page.get_by_role('button', name='配置 Browser AnySearch 登录凭证', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('heading', name='AnySearch 登录凭证')).to_be_visible()
        for label in ['Access token（可选）', 'Refresh token']:
            expect(dialog.get_by_label(label, exact=True)).to_have_attribute('type', 'password')
            expect(dialog.get_by_label(label, exact=True)).to_have_value('')
        return dialog

    dialog = open_login()
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-any-browser-refresh')
    dialog.get_by_role('button', name='保存并查询额度').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    expect(row).to_contain_text('1,000 次')
    expect(row).to_contain_text('993')
    expect(row).to_contain_text('每日重置')
    public = page.request.get(f'{base}/api/keys').text()
    assert 'fixture-any-browser-refresh' not in public and 'anysearch-browser-secret-12345678' not in public
    others = {k['id']: k['usage'] for k in page.request.get(f'{base}/api/keys').json() if k['id'] != key['id']}
    with page.expect_response(lambda r: r.url.endswith(f"/keys/{key['id']}/usage") and r.request.method == 'POST'):
        page.get_by_role('button', name='查询 Browser AnySearch 用量', exact=True).click()
    assert others == {k['id']: k['usage'] for k in page.request.get(f'{base}/api/keys').json() if k['id'] != key['id']}

    pending = page.request.post(f'{base}/api/keys', data={'provider': 'anysearch', 'label': 'Browser AnySearch pending', 'account': 'fixture pending', 'keys': ['any-browser-pending-12345']}).json()[0]
    page.get_by_role('button', name='刷新数据', exact=True).click()
    expect(page.get_by_text('Browser AnySearch pending', exact=True)).to_be_visible()
    for box in page.get_by_role('checkbox', name=re.compile(r'^选择 ')).all():
        box.uncheck()
    page.get_by_role('checkbox', name='选择 Browser AnySearch', exact=True).check()
    page.get_by_role('checkbox', name='选择 Browser AnySearch pending', exact=True).check()
    page.get_by_role('button', name='批量查询所选用量（2）', exact=True).click()
    expect(page.get_by_text('批量查询完成 · 2 / 2', exact=True)).to_be_visible()
    expect(page.locator('.batch-results')).to_contain_text('成功 1 · 失败 0 · 未支持 / 待配置 1')
    assert page.request.delete(f"{base}/api/keys/{pending['id']}").ok
    page.get_by_role('button', name='刷新数据', exact=True).click()
    expect(page.get_by_text('Browser AnySearch pending', exact=True)).not_to_be_visible()

    dialog = open_login()
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-any-invalid-login')
    dialog.get_by_role('button', name='保存并查询额度').click()
    expect(dialog.get_by_role('alert')).to_contain_text('登录已失效', timeout=20000)
    expect(dialog.get_by_label('Refresh token', exact=True)).to_have_value('')
    old = next(k for k in page.request.get(f'{base}/api/keys').json() if k['id'] == key['id'])
    assert old['anysearch_login']['needs_login'] and old['usage']['request_quota']['remaining'] == 993
    assert old['state'] == 'ready'
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-any-browser-recovery')
    dialog.get_by_role('button', name='保存并查询额度').click()
    expect(dialog).not_to_be_visible(timeout=20000)

    seen = []
    def track(request):
        if request.method == 'PUT' and request.url.endswith('/anysearch-session'):
            seen.append(request.url)
    page.on('request', track)
    dialog = open_login()
    dialog.get_by_role('button', name='保存并查询额度').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    page.remove_listener('request', track)
    assert not seen, 'Blank inputs must retain the saved token pair'
    dialog = open_login()
    page.screenshot(path=str(artifacts / 'anysearch-login.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(dialog.get_by_role('button', name='保存并查询额度')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(artifacts / 'anysearch-login-mobile.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width': 1440, 'height': 1050})
    dialog.get_by_role('button', name='移除登录凭证').click()
    expect(dialog).not_to_be_visible()
    removed = next(k for k in page.request.get(f'{base}/api/keys').json() if k['id'] == key['id'])
    assert 'anysearch_login' not in removed and removed['usage'] is None and removed['state'] == 'ready'
    dialog = open_login()
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-any-browser-final')
    dialog.get_by_role('button', name='保存并查询额度').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    assert page.request.get(f'{base}/api/dashboard').json()['calls'] == calls
