# Questions for the VMS Provider

Ask your VMS provider these questions:

1. Do you have an API?
2. Can we pull machine stock levels by API?
3. Can we pull machine sales by API?
4. Can we pull cash expected/collected data by API?
5. Can we pull machine status/uptime/error alerts by API?
6. Can reports be emailed automatically every day?
7. Can we export stock reports as CSV?
8. Can we export sales reports as CSV?
9. What are the stable identifiers for machines?
10. What are the stable identifiers for products?
11. Do slot codes appear in the stock report?
12. Does the VMS report current stock, capacity, and sold quantity?
13. Is there a webhook when stock is empty or machine has an error?
14. Are API docs available?
15. Is API access included or paid?

Best case:

```text
VMS API → Snacky OS backend → Refill engine → Operator app
```

Temporary case:

```text
VMS CSV → Snacky OS import screen → Refill engine → Operator app
```
