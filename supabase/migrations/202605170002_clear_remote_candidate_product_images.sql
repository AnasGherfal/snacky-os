update products
set image_url = null
where image_url like 'https://images.openfoodfacts.org/%';
