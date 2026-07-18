from pathlib import Path
p=Path(__file__).resolve().parents[1]/'src/components/operator/ManualRouteSalesSection.tsx'
s=p.read_text(encoding='utf-8')
def r(a,b,label):
 global s
 c=s.count(a)
 if c!=1: raise RuntimeError(f'{label}: {c}')
 s=s.replace(a,b,1)
AR={
'choose':'\u0627\u062e\u062a\u0631 \u0645\u0646\u062a\u062c\u0627\u064b \u0623\u0648 \u0627\u0643\u062a\u0628 \u0627\u0633\u0645 \u0627\u0644\u0645\u0646\u062a\u062c.',
'qty':'\u064a\u062c\u0628 \u0623\u0646 \u062a\u0643\u0648\u0646 \u0627\u0644\u0643\u0645\u064a\u0629 \u0623\u0643\u0628\u0631 \u0645\u0646 0.',
'price':'\u064a\u062c\u0628 \u0623\u0646 \u064a\u0643\u0648\u0646 \u0633\u0639\u0631 \u0627\u0644\u0648\u062d\u062f\u0629 \u0623\u0643\u0628\u0631 \u0645\u0646 0.',
'saved':'\u062a\u0645 \u062d\u0641\u0638 \u0627\u0644\u0628\u064a\u0639 \u0627\u0644\u064a\u062f\u0648\u064a.',
'cancelled':'\u062a\u0645 \u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u0628\u064a\u0639 \u0627\u0644\u064a\u062f\u0648\u064a.',
'sub':'\u0645\u0628\u064a\u0639\u0627\u062a \u0627\u062e\u062a\u064a\u0627\u0631\u064a\u0629 \u062a\u064f\u0633\u062c\u0651\u064e\u0644 \u0623\u062b\u0646\u0627\u0621 \u0627\u0644\u062a\u0639\u0628\u0626\u0629 \u0645\u0646 \u062f\u0648\u0646 \u062a\u0639\u0637\u064a\u0644 \u0625\u0646\u0647\u0627\u0621 \u0627\u0644\u0645\u0648\u0642\u0639.',
'card':'\u0628\u0637\u0627\u0642\u0629','machine':'\u0627\u0644\u062c\u0647\u0627\u0632','notes':'\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0627\u062e\u062a\u064a\u0627\u0631\u064a\u0629 \u0639\u0646 \u0647\u0630\u0627 \u0627\u0644\u0628\u064a\u0639','unknown':'\u0645\u0646\u062a\u062c \u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0641','now':'\u0627\u0644\u0622\u0646','selected':'\u0627\u0644\u0645\u062d\u062f\u062f','empty':'\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0646\u062a\u062c\u0627\u062a'}
r('setError("\u0627\u062e\u062a\u0631 \u0645\u0646\u062a\u062c\u0627\u064b \u0623\u0648 \u0627\u0643\u062a\u0628 \u0627\u0633\u0645 \u0627\u0644\u0645\u0646\u062a\u062c.");',f'setError(tr("Choose a product or enter the product name.", "{AR["choose"]}"));','choose')
r('setError("\u064a\u062c\u0628 \u0623\u0646 \u062a\u0643\u0648\u0646 \u0627\u0644\u0643\u0645\u064a\u0629 \u0623\u0643\u0628\u0631 \u0645\u0646 0.");',f'setError(tr("Quantity must be greater than 0.", "{AR["qty"]}"));','qty')
r('setError("\u064a\u062c\u0628 \u0623\u0646 \u064a\u0643\u0648\u0646 \u0633\u0639\u0631 \u0627\u0644\u0648\u062d\u062f\u0629 \u0623\u0643\u0628\u0631 \u0645\u0646 0.");',f'setError(tr("Unit price must be greater than 0.", "{AR["price"]}"));','price')
r('setSuccess("\u062a\u0645 \u062d\u0641\u0638 \u0627\u0644\u0628\u064a\u0639 \u0627\u0644\u064a\u062f\u0648\u064a.");',f'setSuccess(tr("Manual sale saved.", "{AR["saved"]}"));','saved')
r('setSuccess("\u062a\u0645 \u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u0628\u064a\u0639 \u0627\u0644\u064a\u062f\u0648\u064a.");',f'setSuccess(tr("Manual sale cancelled.", "{AR["cancelled"]}"));','cancelled')
r('{t("Optional sales recorded during filling without blocking stop completion.", "Optional sales recorded during filling without blocking stop completion.")}',f'{{tr("Optional sales recorded during filling without blocking stop completion.", "{AR["sub"]}")}}','subtitle')
r('{t("Card", "Card")}:',f'{{tr("Card", "{AR["card"]}")}}:','card')
r('{t("Machine", "Machine")}:',f'{{tr("Machine", "{AR["machine"]}")}}:','machine')
r('placeholder={t("Optional context for this sale", "Optional context for this sale")}',f'placeholder={{tr("Optional context for this sale", "{AR["notes"]}")}}','notes')
r('sale.productName || t("Unknown product", "Unknown product")',f'sale.productName || tr("Unknown product", "{AR["unknown"]}")','unknown')
r('t("Just now", "Just now")',f'tr("Just now", "{AR["now"]}")','now')
r('{t("Selected", "Selected")}:',f'{{tr("Selected", "{AR["selected"]}")}}:','selected')
r('{t("No products found", "No products found")}',f'{{tr("No products found", "{AR["empty"]}")}}','empty')
p.write_text(s,encoding='utf-8')