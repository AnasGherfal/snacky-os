import type {MarketChecklistItem} from './market-checklist';

export const marketUnitLabel = (unit:MarketChecklistItem['unit'], ar:boolean) => ({
 boxes:['boxes','صناديق'],packs:['packs','عبوات'],units:['units','وحدات'],
}[unit][ar?1:0]);

export const marketFlexibilityLabel = (value:MarketChecklistItem['flexibility'], ar:boolean) => ({
 exact:['Exact item','الصنف المحدد'],
 any_flavour:['Any flavour is fine','أي نكهة مناسبة'],
 any_brand:['Any suitable brand or flavour','أي علامة أو نكهة مناسبة'],
}[value][ar?1:0]);
