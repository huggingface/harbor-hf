/* Generated from browser-pricing-v1.schema.json by Ajv standalone and esbuild. Do not edit. */
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
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// ../../node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "../../node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// browser-pricing-validator.js
var validate = validate20;
var browser_pricing_validator_default = validate20;
var schema31 = { "$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "browser-pricing-v1", "title": "BrowserPricingV1", "description": "Origin-local display preferences only. Never a server or Bucket record.", "type": "object", "additionalProperties": false, "required": ["schema_version", "scenarios", "selected_id", "tier"], "properties": { "schema_version": { "const": "v1" }, "selected_id": { "type": ["string", "null"], "minLength": 1, "maxLength": 64 }, "tier": { "enum": ["standard", "longContext"] }, "scenarios": { "type": "array", "maxItems": 50, "items": { "type": "object", "additionalProperties": false, "required": ["id", "name", "standard", "longContext", "threshold"], "properties": { "id": { "type": "string", "pattern": "^[a-zA-Z0-9-]{1,64}$" }, "name": { "type": "string", "minLength": 1, "maxLength": 80, "pattern": "\\S" }, "standard": { "$ref": "#/$defs/rates" }, "longContext": { "$ref": "#/$defs/rates" }, "threshold": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 } } } } }, "$defs": { "rates": { "type": "object", "additionalProperties": false, "required": ["input", "output", "cached"], "properties": { "input": { "type": ["number", "null"], "minimum": 0, "maximum": 1e6 }, "output": { "type": ["number", "null"], "minimum": 0, "maximum": 1e6 }, "cached": { "type": ["number", "null"], "minimum": 0, "maximum": 1e6 } } } } };
var schema32 = { "type": "object", "additionalProperties": false, "required": ["input", "output", "cached"], "properties": { "input": { "type": ["number", "null"], "minimum": 0, "maximum": 1e6 }, "output": { "type": ["number", "null"], "minimum": 0, "maximum": 1e6 }, "cached": { "type": ["number", "null"], "minimum": 0, "maximum": 1e6 } } };
var func1 = require_ucs2length().default;
var pattern4 = new RegExp("^[a-zA-Z0-9-]{1,64}$", "u");
var pattern5 = new RegExp("\\S", "u");
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
      if (data.schema_version === void 0 && (missing0 = "schema_version") || data.scenarios === void 0 && (missing0 = "scenarios") || data.selected_id === void 0 && (missing0 = "selected_id") || data.tier === void 0 && (missing0 = "tier")) {
        validate20.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "schema_version" || key0 === "selected_id" || key0 === "tier" || key0 === "scenarios")) {
            validate20.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.schema_version !== void 0) {
            const _errs2 = errors;
            if ("v1" !== data.schema_version) {
              validate20.errors = [{ instancePath: instancePath + "/schema_version", schemaPath: "#/properties/schema_version/const", keyword: "const", params: { allowedValue: "v1" }, message: "must be equal to constant" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.selected_id !== void 0) {
              let data1 = data.selected_id;
              const _errs3 = errors;
              if (typeof data1 !== "string" && data1 !== null) {
                validate20.errors = [{ instancePath: instancePath + "/selected_id", schemaPath: "#/properties/selected_id/type", keyword: "type", params: { type: schema31.properties.selected_id.type }, message: "must be string,null" }];
                return false;
              }
              if (errors === _errs3) {
                if (typeof data1 === "string") {
                  if (func1(data1) > 64) {
                    validate20.errors = [{ instancePath: instancePath + "/selected_id", schemaPath: "#/properties/selected_id/maxLength", keyword: "maxLength", params: { limit: 64 }, message: "must NOT have more than 64 characters" }];
                    return false;
                  } else {
                    if (func1(data1) < 1) {
                      validate20.errors = [{ instancePath: instancePath + "/selected_id", schemaPath: "#/properties/selected_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    }
                  }
                }
              }
              var valid0 = _errs3 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.tier !== void 0) {
                let data2 = data.tier;
                const _errs5 = errors;
                if (!(data2 === "standard" || data2 === "longContext")) {
                  validate20.errors = [{ instancePath: instancePath + "/tier", schemaPath: "#/properties/tier/enum", keyword: "enum", params: { allowedValues: schema31.properties.tier.enum }, message: "must be equal to one of the allowed values" }];
                  return false;
                }
                var valid0 = _errs5 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.scenarios !== void 0) {
                  let data3 = data.scenarios;
                  const _errs6 = errors;
                  if (errors === _errs6) {
                    if (Array.isArray(data3)) {
                      if (data3.length > 50) {
                        validate20.errors = [{ instancePath: instancePath + "/scenarios", schemaPath: "#/properties/scenarios/maxItems", keyword: "maxItems", params: { limit: 50 }, message: "must NOT have more than 50 items" }];
                        return false;
                      } else {
                        var valid1 = true;
                        const len0 = data3.length;
                        for (let i0 = 0; i0 < len0; i0++) {
                          let data4 = data3[i0];
                          const _errs8 = errors;
                          if (errors === _errs8) {
                            if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
                              let missing1;
                              if (data4.id === void 0 && (missing1 = "id") || data4.name === void 0 && (missing1 = "name") || data4.standard === void 0 && (missing1 = "standard") || data4.longContext === void 0 && (missing1 = "longContext") || data4.threshold === void 0 && (missing1 = "threshold")) {
                                validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0, schemaPath: "#/properties/scenarios/items/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                                return false;
                              } else {
                                const _errs10 = errors;
                                for (const key1 in data4) {
                                  if (!(key1 === "id" || key1 === "name" || key1 === "standard" || key1 === "longContext" || key1 === "threshold")) {
                                    validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0, schemaPath: "#/properties/scenarios/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" }];
                                    return false;
                                    break;
                                  }
                                }
                                if (_errs10 === errors) {
                                  if (data4.id !== void 0) {
                                    let data5 = data4.id;
                                    const _errs11 = errors;
                                    if (errors === _errs11) {
                                      if (typeof data5 === "string") {
                                        if (!pattern4.test(data5)) {
                                          validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/id", schemaPath: "#/properties/scenarios/items/properties/id/pattern", keyword: "pattern", params: { pattern: "^[a-zA-Z0-9-]{1,64}$" }, message: 'must match pattern "^[a-zA-Z0-9-]{1,64}$"' }];
                                          return false;
                                        }
                                      } else {
                                        validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/id", schemaPath: "#/properties/scenarios/items/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                        return false;
                                      }
                                    }
                                    var valid2 = _errs11 === errors;
                                  } else {
                                    var valid2 = true;
                                  }
                                  if (valid2) {
                                    if (data4.name !== void 0) {
                                      let data6 = data4.name;
                                      const _errs13 = errors;
                                      if (errors === _errs13) {
                                        if (typeof data6 === "string") {
                                          if (func1(data6) > 80) {
                                            validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/name", schemaPath: "#/properties/scenarios/items/properties/name/maxLength", keyword: "maxLength", params: { limit: 80 }, message: "must NOT have more than 80 characters" }];
                                            return false;
                                          } else {
                                            if (func1(data6) < 1) {
                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/name", schemaPath: "#/properties/scenarios/items/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                              return false;
                                            } else {
                                              if (!pattern5.test(data6)) {
                                                validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/name", schemaPath: "#/properties/scenarios/items/properties/name/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                                                return false;
                                              }
                                            }
                                          }
                                        } else {
                                          validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/name", schemaPath: "#/properties/scenarios/items/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                          return false;
                                        }
                                      }
                                      var valid2 = _errs13 === errors;
                                    } else {
                                      var valid2 = true;
                                    }
                                    if (valid2) {
                                      if (data4.standard !== void 0) {
                                        let data7 = data4.standard;
                                        const _errs15 = errors;
                                        const _errs16 = errors;
                                        if (errors === _errs16) {
                                          if (data7 && typeof data7 == "object" && !Array.isArray(data7)) {
                                            let missing2;
                                            if (data7.input === void 0 && (missing2 = "input") || data7.output === void 0 && (missing2 = "output") || data7.cached === void 0 && (missing2 = "cached")) {
                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard", schemaPath: "#/$defs/rates/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" }];
                                              return false;
                                            } else {
                                              const _errs18 = errors;
                                              for (const key2 in data7) {
                                                if (!(key2 === "input" || key2 === "output" || key2 === "cached")) {
                                                  validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard", schemaPath: "#/$defs/rates/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key2 }, message: "must NOT have additional properties" }];
                                                  return false;
                                                  break;
                                                }
                                              }
                                              if (_errs18 === errors) {
                                                if (data7.input !== void 0) {
                                                  let data8 = data7.input;
                                                  const _errs19 = errors;
                                                  if (!(typeof data8 == "number") && data8 !== null) {
                                                    validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/input", schemaPath: "#/$defs/rates/properties/input/type", keyword: "type", params: { type: schema32.properties.input.type }, message: "must be number,null" }];
                                                    return false;
                                                  }
                                                  if (errors === _errs19) {
                                                    if (typeof data8 == "number") {
                                                      if (data8 > 1e6 || isNaN(data8)) {
                                                        validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/input", schemaPath: "#/$defs/rates/properties/input/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                                                        return false;
                                                      } else {
                                                        if (data8 < 0 || isNaN(data8)) {
                                                          validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/input", schemaPath: "#/$defs/rates/properties/input/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                          return false;
                                                        }
                                                      }
                                                    }
                                                  }
                                                  var valid4 = _errs19 === errors;
                                                } else {
                                                  var valid4 = true;
                                                }
                                                if (valid4) {
                                                  if (data7.output !== void 0) {
                                                    let data9 = data7.output;
                                                    const _errs21 = errors;
                                                    if (!(typeof data9 == "number") && data9 !== null) {
                                                      validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/output", schemaPath: "#/$defs/rates/properties/output/type", keyword: "type", params: { type: schema32.properties.output.type }, message: "must be number,null" }];
                                                      return false;
                                                    }
                                                    if (errors === _errs21) {
                                                      if (typeof data9 == "number") {
                                                        if (data9 > 1e6 || isNaN(data9)) {
                                                          validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/output", schemaPath: "#/$defs/rates/properties/output/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                                                          return false;
                                                        } else {
                                                          if (data9 < 0 || isNaN(data9)) {
                                                            validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/output", schemaPath: "#/$defs/rates/properties/output/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                            return false;
                                                          }
                                                        }
                                                      }
                                                    }
                                                    var valid4 = _errs21 === errors;
                                                  } else {
                                                    var valid4 = true;
                                                  }
                                                  if (valid4) {
                                                    if (data7.cached !== void 0) {
                                                      let data10 = data7.cached;
                                                      const _errs23 = errors;
                                                      if (!(typeof data10 == "number") && data10 !== null) {
                                                        validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/cached", schemaPath: "#/$defs/rates/properties/cached/type", keyword: "type", params: { type: schema32.properties.cached.type }, message: "must be number,null" }];
                                                        return false;
                                                      }
                                                      if (errors === _errs23) {
                                                        if (typeof data10 == "number") {
                                                          if (data10 > 1e6 || isNaN(data10)) {
                                                            validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/cached", schemaPath: "#/$defs/rates/properties/cached/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                                                            return false;
                                                          } else {
                                                            if (data10 < 0 || isNaN(data10)) {
                                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard/cached", schemaPath: "#/$defs/rates/properties/cached/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                              return false;
                                                            }
                                                          }
                                                        }
                                                      }
                                                      var valid4 = _errs23 === errors;
                                                    } else {
                                                      var valid4 = true;
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          } else {
                                            validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/standard", schemaPath: "#/$defs/rates/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                                            return false;
                                          }
                                        }
                                        var valid2 = _errs15 === errors;
                                      } else {
                                        var valid2 = true;
                                      }
                                      if (valid2) {
                                        if (data4.longContext !== void 0) {
                                          let data11 = data4.longContext;
                                          const _errs25 = errors;
                                          const _errs26 = errors;
                                          if (errors === _errs26) {
                                            if (data11 && typeof data11 == "object" && !Array.isArray(data11)) {
                                              let missing3;
                                              if (data11.input === void 0 && (missing3 = "input") || data11.output === void 0 && (missing3 = "output") || data11.cached === void 0 && (missing3 = "cached")) {
                                                validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext", schemaPath: "#/$defs/rates/required", keyword: "required", params: { missingProperty: missing3 }, message: "must have required property '" + missing3 + "'" }];
                                                return false;
                                              } else {
                                                const _errs28 = errors;
                                                for (const key3 in data11) {
                                                  if (!(key3 === "input" || key3 === "output" || key3 === "cached")) {
                                                    validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext", schemaPath: "#/$defs/rates/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key3 }, message: "must NOT have additional properties" }];
                                                    return false;
                                                    break;
                                                  }
                                                }
                                                if (_errs28 === errors) {
                                                  if (data11.input !== void 0) {
                                                    let data12 = data11.input;
                                                    const _errs29 = errors;
                                                    if (!(typeof data12 == "number") && data12 !== null) {
                                                      validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/input", schemaPath: "#/$defs/rates/properties/input/type", keyword: "type", params: { type: schema32.properties.input.type }, message: "must be number,null" }];
                                                      return false;
                                                    }
                                                    if (errors === _errs29) {
                                                      if (typeof data12 == "number") {
                                                        if (data12 > 1e6 || isNaN(data12)) {
                                                          validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/input", schemaPath: "#/$defs/rates/properties/input/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                                                          return false;
                                                        } else {
                                                          if (data12 < 0 || isNaN(data12)) {
                                                            validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/input", schemaPath: "#/$defs/rates/properties/input/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                            return false;
                                                          }
                                                        }
                                                      }
                                                    }
                                                    var valid6 = _errs29 === errors;
                                                  } else {
                                                    var valid6 = true;
                                                  }
                                                  if (valid6) {
                                                    if (data11.output !== void 0) {
                                                      let data13 = data11.output;
                                                      const _errs31 = errors;
                                                      if (!(typeof data13 == "number") && data13 !== null) {
                                                        validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/output", schemaPath: "#/$defs/rates/properties/output/type", keyword: "type", params: { type: schema32.properties.output.type }, message: "must be number,null" }];
                                                        return false;
                                                      }
                                                      if (errors === _errs31) {
                                                        if (typeof data13 == "number") {
                                                          if (data13 > 1e6 || isNaN(data13)) {
                                                            validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/output", schemaPath: "#/$defs/rates/properties/output/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                                                            return false;
                                                          } else {
                                                            if (data13 < 0 || isNaN(data13)) {
                                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/output", schemaPath: "#/$defs/rates/properties/output/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                              return false;
                                                            }
                                                          }
                                                        }
                                                      }
                                                      var valid6 = _errs31 === errors;
                                                    } else {
                                                      var valid6 = true;
                                                    }
                                                    if (valid6) {
                                                      if (data11.cached !== void 0) {
                                                        let data14 = data11.cached;
                                                        const _errs33 = errors;
                                                        if (!(typeof data14 == "number") && data14 !== null) {
                                                          validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/cached", schemaPath: "#/$defs/rates/properties/cached/type", keyword: "type", params: { type: schema32.properties.cached.type }, message: "must be number,null" }];
                                                          return false;
                                                        }
                                                        if (errors === _errs33) {
                                                          if (typeof data14 == "number") {
                                                            if (data14 > 1e6 || isNaN(data14)) {
                                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/cached", schemaPath: "#/$defs/rates/properties/cached/maximum", keyword: "maximum", params: { comparison: "<=", limit: 1e6 }, message: "must be <= 1000000" }];
                                                              return false;
                                                            } else {
                                                              if (data14 < 0 || isNaN(data14)) {
                                                                validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext/cached", schemaPath: "#/$defs/rates/properties/cached/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                                return false;
                                                              }
                                                            }
                                                          }
                                                        }
                                                        var valid6 = _errs33 === errors;
                                                      } else {
                                                        var valid6 = true;
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            } else {
                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/longContext", schemaPath: "#/$defs/rates/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                                              return false;
                                            }
                                          }
                                          var valid2 = _errs25 === errors;
                                        } else {
                                          var valid2 = true;
                                        }
                                        if (valid2) {
                                          if (data4.threshold !== void 0) {
                                            let data15 = data4.threshold;
                                            const _errs35 = errors;
                                            if (!(typeof data15 == "number" && (!(data15 % 1) && !isNaN(data15)))) {
                                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/threshold", schemaPath: "#/properties/scenarios/items/properties/threshold/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                              return false;
                                            }
                                            if (errors === _errs35) {
                                              if (typeof data15 == "number") {
                                                if (data15 > 9007199254740991 || isNaN(data15)) {
                                                  validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/threshold", schemaPath: "#/properties/scenarios/items/properties/threshold/maximum", keyword: "maximum", params: { comparison: "<=", limit: 9007199254740991 }, message: "must be <= 9007199254740991" }];
                                                  return false;
                                                } else {
                                                  if (data15 < 0 || isNaN(data15)) {
                                                    validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0 + "/threshold", schemaPath: "#/properties/scenarios/items/properties/threshold/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                                    return false;
                                                  }
                                                }
                                              }
                                            }
                                            var valid2 = _errs35 === errors;
                                          } else {
                                            var valid2 = true;
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            } else {
                              validate20.errors = [{ instancePath: instancePath + "/scenarios/" + i0, schemaPath: "#/properties/scenarios/items/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                              return false;
                            }
                          }
                          var valid1 = _errs8 === errors;
                          if (!valid1) {
                            break;
                          }
                        }
                      }
                    } else {
                      validate20.errors = [{ instancePath: instancePath + "/scenarios", schemaPath: "#/properties/scenarios/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                      return false;
                    }
                  }
                  var valid0 = _errs6 === errors;
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
  browser_pricing_validator_default as default,
  validate
};
