'use client';

import {useMemo,useState} from 'react';
import {FormField} from '@/components/ui';

type SiteOption={
  id:string;
  label:string;
  distance_from_storage_km?:number|string|null;
};

export function MachineSiteDistanceFields({
  locations,
  initialLocationId='',
}:{
  locations:SiteOption[];
  initialLocationId?:string|null;
}){
  const byId=useMemo(()=>new Map(locations.map(location=>[location.id,location])),[locations]);
  const normalizedInitial=initialLocationId??'';
  const [locationId,setLocationId]=useState(normalizedInitial);
  const initialDistance=normalizedInitial?byId.get(normalizedInitial)?.distance_from_storage_km:null;
  const [distance,setDistance]=useState(initialDistance===null||initialDistance===undefined?'':String(initialDistance));

  function changeLocation(next:string){
    setLocationId(next);
    const value=next?byId.get(next)?.distance_from_storage_km:null;
    setDistance(value===null||value===undefined?'':String(value));
  }

  return <>
    <FormField label="Current active site">
      <select name="location_id" value={locationId} onChange={event=>changeLocation(event.target.value)} className="field-input">
        <option value="">No site assigned</option>
        {locations.map(location=><option key={location.id} value={location.id}>{location.label}</option>)}
      </select>
    </FormField>
    <FormField
      label="One-way distance from storage (km)"
      hint={locationId
        ?"Saved on the site so every machine at the same location uses one consistent distance. Leave blank if not known yet."
        :"Choose a site first. Distance is stored on the site, not duplicated on the physical machine."}
    >
      <input
        type="number"
        min="0"
        step="0.01"
        name="distance_from_storage_km"
        value={distance}
        onChange={event=>setDistance(event.target.value)}
        disabled={!locationId}
        placeholder={locationId?"e.g. 12.5":"Choose a site"}
        className="field-input"
      />
    </FormField>
  </>;
}
