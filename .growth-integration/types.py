from pathlib import Path
from hashlib import sha256

path = Path('src/lib/storage-inventory-data.ts')
source = path.read_text()
assert sha256(source.encode()).hexdigest() == 'afc3d92e51429e2522c21bc273ac1da8c3f5b70fcbcd7b868ceaa1ddfe039cee'
old = '''    ({ from, to, signal }) => client.from("products")
      .select(legacy ? "id,name,sku,category,brand,case_quantity,active" : "id,name,sku,category,brand,case_quantity,min_storage_qty,active", { count: "exact" })
      .order("id").range(from, to).abortSignal(signal),'''
new = '''    ({ from, to, signal }) => {
      // Keep each select literal separate so PostgREST's type parser can infer
      // both shapes. The legacy shape intentionally omits the optional minimum.
      const query = legacy
        ? client.from("products").select("id,name,sku,category,brand,case_quantity,active", { count: "exact" })
        : client.from("products").select("id,name,sku,category,brand,case_quantity,min_storage_qty,active", { count: "exact" });
      return query.order("id").range(from, to).abortSignal(signal);
    },'''
assert source.count(old) == 1
path.write_text(source.replace(old, new))
print('Preserved exact-count and permission filters; corrected literal query typing.')
