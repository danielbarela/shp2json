var spawn = require('child_process').spawn;
var gdal = require('gdal');
var fs = require('fs');
var path = require('path');
var seq = require('seq');
var findit = require('findit');
var duplex = require('duplexify')
var from = require('from2');

module.exports = function (inStream) {
    var id = Math.floor(Math.random() * (1<<30)).toString(16);
    var tmpDir = path.join('/tmp', id);
    var zipFile = path.join('/tmp', id + '.zip');

    var outStream = duplex.obj();

    var zipStream = fs.createWriteStream(zipFile);
    inStream.pipe(zipStream);
    zipStream.on('error', outStream.destroy);

    seq()
        .par(function () { fs.mkdir(tmpDir, 0700, this) })
        .par(function () {
            if (zipStream.closed) this()
            else zipStream.on('close', this.ok)
        })
        .seq_(function (next) {
            var ps = spawn('unzip', [ '-d', tmpDir, zipFile ]);
            ps.on('exit', function (code) {
                next(code < 3 ? null : 'error in unzip: code ' + code)
            });
        })
        .seq_(function (next) {
            var s = findit(tmpDir);
            var files = [];
            s.on('file', function (file) {
                if (file.match(/__MACOSX/)) return;
                if (file.match(/\.shp$|\.kml$/i)) files.push(file);
            });
            s.on('end', next.ok.bind(null, files));
        })
        .seq(function (files) {
            if (files.length === 0) {
                this('no .shp files found in the archive');
            }
            else {
                var fileCount = files.length;

                var before = '{"type": "FeatureCollection","features": [\n';
                var after = '\n]}\n';
                var started = false;
                var currentLayer, currentFeature, currentTransformation, shp;
                var nextLayer, layerCount, nextFile = 0;

                var to = gdal.SpatialReference.fromEPSG(4326);

                function getNextLayer() {
                  if (nextLayer === layerCount) {
                    shp = gdal.open(files[nextFile++]);
                    layerCount = shp.layers.count();
                    nextLayer = 0;
                  }
                  currentLayer = shp.layers.get(nextLayer++);
                  var srs = currentLayer.srs || gdal.SpatialReference.fromEPSG(4326);
                  currentTransformation = new gdal.CoordinateTransformation(srs, to);
                }

                getNextLayer();

                var layerStream = from(function(size, next) {
                  var out = '';
                  writeNextFeature();

                  function writeNextFeature() {
                      var feature = currentLayer.features.next();
                      if (!feature) {
                          // end stream
                          if (nextFile === fileCount) {
                              // push remaining output and end
                              layerStream.push(out);
                              layerStream.push(after);
                              return layerStream.push(null);
                          }
                          getNextLayer();
                          feature = currentLayer.features.next();
                      }

                      try {
                          var geom = feature.getGeometry();
                          if (!geom) {
                            return writeNextFeature();
                          }
                      } catch (e) {
                          return writeNextFeature();
                      }

                      geom.transform(currentTransformation);
                      var geojson = geom.toJSON();
                      var fields = {};
                      if (fileCount > 1) {
                        fields.shapefile = path.basename(files[nextFile]);
                      }
                      feature.fields.forEach(function(value, key) {
                        fields[key] = value;
                      });
                      var featStr = '{"type": "Feature", "properties": ' + JSON.stringify(fields) + ',"geometry": ' + geojson + '}';

                      if (started) {
                          featStr = ',\n' + featStr;
                      } else {
                          featStr = before + featStr;
                      }

                      started = true;
                      out += featStr;

                      if (out.length >= size) {
                          next(null, out);
                      } else {
                          writeNextFeature();
                      }
                  }

                })

                outStream.setReadable(layerStream);
                outStream.end(after);

            }
        })
        .catch(function (err) {
            outStream.destroy(err);
        })
    ;

    return outStream;
};
