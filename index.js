const fs = require('fs')
const express = require('express')
const sphericalmercator = require('sphericalmercator')
const supercluster = require('supercluster')
const mapnik = require('mapnik')
const geojsonvt = require('geojson-vt')
const vtpbf = require('vt-pbf')
const { Pool } = require('pg')

const pgPool = new Pool({
  user: 'john',
  port: 5432,
  host: 'localhost',
  database: 'clustertest'
})

function queryPg(query, params, callback) {
  pgPool.connect((err, client, done) => {
    if (err) throw err
    client.query(query, params, (err, res) => {
      done()

      if (err) return callback(err)
      callback(null, res.rows)
    })
  })
}

const app = express()
const merc = new sphericalmercator({
  size: 512
})

app.get('/', function(req, res) {
  res.sendFile(__dirname + '/index.html')
})
app.get('/:z/:x/:y', getTile)

app.listen(3000, function () {
  console.log('Example app listening on port 3000!')
})

function getTile(req, res) {
  /*
    1. Get tile request
    2. Convert to bbox
    3. Query PostGIS using that bbox
    4. Load result into supercluster index
    5. Call cluster index method `getTile(z, x, y)`
    6. Return that to the client
  */
  
  let x = parseInt(req.params.x)
  let y = parseInt(req.params.y)
  let z = parseInt(req.params.z)

  let bbox = merc.bbox(x, y, z)

  let polygon = `SRID=4326;POLYGON((${bbox[0]} ${bbox[1]}, ${bbox[0]} ${bbox[3]}, ${bbox[2]} ${bbox[3]}, ${bbox[2]} ${bbox[1]}, ${bbox[0]} ${bbox[1]} ))`

  queryPg(`
    SELECT checkin_id, ST_AsGeoJSON(geom) AS geom
    FROM checkins
    WHERE ST_Intersects($1, ST_SetSRID(geom, 4326))
    AND geom IS NOT NULL
  `, [ polygon ], (error, result) => {
    if (error) {
      console.log(error)
    }

    let index = supercluster({
      minZoom: z,
      maxZoom: z,
      radius: 100,
      extent: 512
    })

    index.load(result.map(p => {
      return {
        "type": "Feature",
        "geometry": JSON.parse(p.geom),
        "properties": {
          "checkin_id": p.checkin_id
        }
      }
    }))

    let tile
    try {
      tile = Buffer(vtpbf.fromGeojsonVt({ 'clusters': index.getTile(z, x, y) }, { extent: 512, version: 2 }))
    } catch(e) {
      tile = new mapnik.VectorTile(z, x, y).getData()
    }

    // Mapbox GL JS gets whiney and incorrectly renders if it isn't a 201 on an empty response
    if (tile.length === 0) {
      res.status(201)
    }
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Content-Type':' application/x-protobuf'
    })
    res.send(tile)
  })

}
