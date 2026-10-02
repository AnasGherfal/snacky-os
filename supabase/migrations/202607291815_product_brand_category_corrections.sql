-- Correct known product family categories.
-- Match both product name and brand so existing and newly imported variants are covered.

update public.products
set category = 'Chocolates',
    updated_at = now()
where lower(coalesce(name, '')) like '%laviva%'
   or lower(coalesce(brand, '')) like '%laviva%'
   or lower(coalesce(name, '')) like '%lupo%'
   or lower(coalesce(brand, '')) like '%lupo%';

update public.products
set category = 'Chips',
    updated_at = now()
where lower(coalesce(name, '')) like '%spuds%'
   or lower(coalesce(brand, '')) like '%spuds%';

update public.products
set category = 'Drinks',
    updated_at = now()
where lower(coalesce(name, '')) like '%sirma%'
   or lower(coalesce(brand, '')) like '%sirma%';
