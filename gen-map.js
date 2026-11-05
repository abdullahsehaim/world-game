// يولّد public/world.json : مسارات الدول بإسقاط Natural Earth + مراكزها
const fs = require('fs');
const topojson = require('topojson-client');
const d3 = require('d3-geo');
const countries = require('i18n-iso-countries');
const world = require('world-atlas/countries-110m.json');

const W = 1000, H = 520;
const proj = d3.geoNaturalEarth1().fitExtent([[0,0],[W,H]], {type:'Sphere'});
const path = d3.geoPath(proj);
const fc = topojson.feature(world, world.objects.countries);
const out = { width: W, height: H, scale: proj.scale(), translate: proj.translate(), countries: [] };
for (const f of fc.features) {
  const a2 = countries.numericToAlpha2(f.id);
  if (!a2) continue;
  if (a2 === 'AQ') continue;
  const c = path.centroid(f);
  const b = path.bounds(f);
  out.countries.push({ id: a2, name: countries.getName(a2, 'ar') || countries.getName(a2,'en') || f.properties.name,
    d: path(f), cx: +c[0].toFixed(1), cy: +c[1].toFixed(1), bbox: b.flat().map(v=>+v.toFixed(1)) });
}
fs.writeFileSync('public/world.json', JSON.stringify(out));
console.log('countries:', out.countries.length, 'sample', out.countries.find(c=>c.id==='SA'));
