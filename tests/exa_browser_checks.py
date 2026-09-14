"""E1-E5 cookie and balance UI acceptance against an isolated fake upstream."""
import re
from playwright.sync_api import expect


def check_exa_login(page, artifacts):
    base = 'http://127.0.0.1:8876'
    key = next(k for k in page.request.get(f'{base}/api/keys').json() if k['label'] == 'Browser Exa')
    calls = page.request.get(f'{base}/api/dashboard').json()['calls']
    row = page.locator('tr').filter(has=page.get_by_text('Browser Exa', exact=True))

    def open_login():
        page.get_by_role('button', name='配置 Browser Exa 登录凭证', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('heading', name='Exa 登录凭证')).to_be_visible()
        expect(dialog.get_by_label('会话 Cookie', exact=True)).to_have_attribute('type', 'password')
        expect(dialog.get_by_label('会话 Cookie', exact=True)).to_have_value('')
        return dialog

    dialog = open_login()
    dialog.get_by_label('Team ID', exact=True).fill('fixture-exa-team')
    bare_cookie = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..fixture-iv.fixture-browser-ciphertext.fixture-tag'
    expect(dialog.get_by_label('会话 Cookie', exact=True)).to_have_attribute('placeholder', '直接粘贴完整会话值，或填写 名称=值')
    dialog.get_by_label('会话 Cookie', exact=True).fill(bare_cookie)
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    expect(row).to_contain_text('官网余额 $20.00')
    row.get_by_text('1 笔额度有到期时间（已含在余额中）', exact=True).click()
    expect(row).to_contain_text('$10.00 到期于')
    expect(row).to_contain_text('2026')
    public = page.request.get(f'{base}/api/keys').text()
    assert bare_cookie not in public
    others = {k['id']: k['usage'] for k in page.request.get(f'{base}/api/keys').json() if k['id'] != key['id']}
    with page.expect_response(lambda r: r.url.endswith(f"/keys/{key['id']}/usage") and r.request.method == 'POST'):
        page.get_by_role('button', name='查询 Browser Exa 用量', exact=True).click()
    assert others == {k['id']: k['usage'] for k in page.request.get(f'{base}/api/keys').json() if k['id'] != key['id']}

    pending = page.request.post(f'{base}/api/keys', data={'provider': 'exa', 'label': 'Browser Exa pending', 'account': 'fixture pending', 'keys': ['exa-browser-pending-12345']}).json()[0]
    page.get_by_role('button', name='刷新数据', exact=True).click()
    expect(page.get_by_text('Browser Exa pending', exact=True)).to_be_visible()
    for box in page.get_by_role('checkbox', name=re.compile(r'^选择 ')).all():
        box.uncheck()
    page.get_by_role('checkbox', name='选择 Browser Exa', exact=True).check()
    page.get_by_role('checkbox', name='选择 Browser Exa pending', exact=True).check()
    page.get_by_role('button', name='批量查询所选用量（2）', exact=True).click()
    expect(page.get_by_text('批量查询完成 · 2 / 2', exact=True)).to_be_visible()
    expect(page.locator('.batch-results')).to_contain_text('成功 1 · 失败 0 · 未支持 / 待配置 1')
    assert page.request.delete(f"{base}/api/keys/{pending['id']}").ok
    page.get_by_role('button', name='刷新数据', exact=True).click()
    expect(page.get_by_text('Browser Exa pending', exact=True)).not_to_be_visible()

    dialog = open_login()
    expect(dialog.get_by_label('Team ID', exact=True)).to_have_value('fixture-exa-team')
    dialog.get_by_label('Team ID', exact=True).fill('different-team')
    expect(dialog.get_by_label('会话 Cookie', exact=True)).to_have_attribute('required', '')
    dialog.get_by_label('Team ID', exact=True).fill('fixture-exa-team')
    dialog.get_by_label('会话 Cookie', exact=True).fill('next-auth.session-token=fixture-browser-expired')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog.get_by_role('alert')).to_contain_text('登录已失效', timeout=20000)
    expect(dialog.get_by_label('会话 Cookie', exact=True)).to_have_value('')
    old = next(k for k in page.request.get(f'{base}/api/keys').json() if k['id'] == key['id'])
    assert old['exa_login']['needs_login'] and old['usage']['money_balance']['available_cents'] == 2000
    assert old['state'] == 'ready'
    dialog.get_by_label('会话 Cookie', exact=True).fill('next-auth.session-token=fixture-browser-recovery; _ga=ignored-tracker')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    assert 'ignored-tracker' not in page.request.get(f'{base}/api/keys').text()

    seen = []
    def track(request):
        if request.method == 'PUT' and request.url.endswith('/exa-session'):
            seen.append(request.url)
    page.on('request', track)
    dialog = open_login()
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    page.remove_listener('request', track)
    assert not seen, 'Blank cookie must retain the latest saved session'
    dialog = open_login()
    page.screenshot(path=str(artifacts / 'exa-login.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(dialog.get_by_role('button', name='保存并查询余额')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(artifacts / 'exa-login-mobile.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width': 1440, 'height': 1050})
    dialog.get_by_role('button', name='移除登录凭证').click()
    expect(dialog).not_to_be_visible()
    removed = next(k for k in page.request.get(f'{base}/api/keys').json() if k['id'] == key['id'])
    assert 'exa_login' not in removed and removed['usage'] is None and removed['state'] == 'ready'
    dialog = open_login()
    dialog.get_by_label('Team ID', exact=True).fill('fixture-exa-team')
    dialog.get_by_label('会话 Cookie', exact=True).fill('next-auth.session-token=fixture-browser-final')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    assert page.request.get(f'{base}/api/dashboard').json()['calls'] == calls
