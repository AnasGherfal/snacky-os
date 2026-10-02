from pathlib import Path
from playwright.sync_api import sync_playwright

OUT=Path(".qa/urgent-escalation")
OUT.mkdir(parents=True,exist_ok=True)
URL="http://127.0.0.1:3000/login/qa-urgent-escalation"

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={"width":390,"height":900})
    errors=[]
    page.on("pageerror",lambda error: errors.append(str(error)))
    page.goto(URL,wait_until="networkidle")
    page.get_by_text("No active notification device — contact the operator directly.",exact=True).wait_for()
    english_overdue=page.get_by_text("Urgent acceptance is overdue — contact or reassign the operator now.",exact=True)
    assert english_overdue.count()==2, f"expected two English overdue task banners, got {english_overdue.count()}"
    english_overdue.first.wait_for()
    page.get_by_text("Push is ready on 2 registered device(s). Provider acceptance does not mean the operator saw it.",exact=True).wait_for()
    page.get_by_text("لا يوجد جهاز مسجل للإشعارات لدى المشغّل — تواصل معه مباشرة.",exact=True).wait_for()
    arabic_overdue=page.get_by_text("تأخر قبول المهمة العاجلة — تواصل مع المشغّل أو أعد إسنادها الآن.",exact=True)
    assert arabic_overdue.count()==2, f"expected two Arabic overdue task banners, got {arabic_overdue.count()}"
    arabic_overdue.first.wait_for()
    page.get_by_text("إشعارات الهاتف مفعلة على 2 جهاز. قبول خدمة الإشعار لا يعني أن المشغّل شاهد الرسالة.",exact=True).wait_for()
    for width in (390,320):
        page.set_viewport_size({"width":width,"height":900})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 2"), f"horizontal overflow at {width}px"
        page.screenshot(path=str(OUT/f"crm-readiness-{width}.png"),full_page=True)
    assert not errors, errors
    browser.close()
print("PASS: real CRM dispatch readiness component at 390px/320px, English/Arabic")
