/* Generated from launch-pricing-v1.schema.json by Ajv standalone and esbuild. Do not edit. */
/*! Bundled Ajv runtime license:
The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

// launch-pricing-validator.js
var validate = validate20;
var launch_pricing_validator_default = validate20;
function validate20(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.currency === void 0 && (missing0 = "currency") || data.input_usd_per_million === void 0 && (missing0 = "input_usd_per_million") || data.output_usd_per_million === void 0 && (missing0 = "output_usd_per_million") || data.cached_usd_per_million === void 0 && (missing0 = "cached_usd_per_million")) {
        validate20.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "currency" || key0 === "input_usd_per_million" || key0 === "output_usd_per_million" || key0 === "cached_usd_per_million")) {
            validate20.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.currency !== void 0) {
            const _errs2 = errors;
            if ("USD" !== data.currency) {
              validate20.errors = [{ instancePath: instancePath + "/currency", schemaPath: "#/properties/currency/const", keyword: "const", params: { allowedValue: "USD" }, message: "must be equal to constant" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.input_usd_per_million !== void 0) {
              let data1 = data.input_usd_per_million;
              const _errs3 = errors;
              if (errors === _errs3) {
                if (typeof data1 == "number") {
                  if (data1 > 1e6 || isNaN(data1)) {
                    validate20.errors = [{ instancePath: instancePath + "/input_usd_per_million", schemaPath: "#/properties/input_usd_per_million/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                    return false;
                  } else {
                    if (data1 < 0 || isNaN(data1)) {
                      validate20.errors = [{ instancePath: instancePath + "/input_usd_per_million", schemaPath: "#/properties/input_usd_per_million/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                      return false;
                    }
                  }
                } else {
                  validate20.errors = [{ instancePath: instancePath + "/input_usd_per_million", schemaPath: "#/properties/input_usd_per_million/type", keyword: "type", params: { type: "number" }, message: "must be number" }];
                  return false;
                }
              }
              var valid0 = _errs3 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.output_usd_per_million !== void 0) {
                let data2 = data.output_usd_per_million;
                const _errs5 = errors;
                if (errors === _errs5) {
                  if (typeof data2 == "number") {
                    if (data2 > 1e6 || isNaN(data2)) {
                      validate20.errors = [{ instancePath: instancePath + "/output_usd_per_million", schemaPath: "#/properties/output_usd_per_million/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                      return false;
                    } else {
                      if (data2 < 0 || isNaN(data2)) {
                        validate20.errors = [{ instancePath: instancePath + "/output_usd_per_million", schemaPath: "#/properties/output_usd_per_million/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                        return false;
                      }
                    }
                  } else {
                    validate20.errors = [{ instancePath: instancePath + "/output_usd_per_million", schemaPath: "#/properties/output_usd_per_million/type", keyword: "type", params: { type: "number" }, message: "must be number" }];
                    return false;
                  }
                }
                var valid0 = _errs5 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.cached_usd_per_million !== void 0) {
                  let data3 = data.cached_usd_per_million;
                  const _errs7 = errors;
                  if (errors === _errs7) {
                    if (typeof data3 == "number") {
                      if (data3 > 1e6 || isNaN(data3)) {
                        validate20.errors = [{ instancePath: instancePath + "/cached_usd_per_million", schemaPath: "#/properties/cached_usd_per_million/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                        return false;
                      } else {
                        if (data3 < 0 || isNaN(data3)) {
                          validate20.errors = [{ instancePath: instancePath + "/cached_usd_per_million", schemaPath: "#/properties/cached_usd_per_million/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                          return false;
                        }
                      }
                    } else {
                      validate20.errors = [{ instancePath: instancePath + "/cached_usd_per_million", schemaPath: "#/properties/cached_usd_per_million/type", keyword: "type", params: { type: "number" }, message: "must be number" }];
                      return false;
                    }
                  }
                  var valid0 = _errs7 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate20.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
export {
  launch_pricing_validator_default as default,
  validate
};
