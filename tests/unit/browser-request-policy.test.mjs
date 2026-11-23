import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBrowserRequest } from "../../dist/browser-request-policy.js";

const origin = "https://www.ebay.com";
const req = (url, extra = {}) => ({
  url, method: "GET", resourceType: "script",
  isNavigationRequest: false, ...extra,
});
test("approved website keeps ordinary navigation and form submissions", () => {
  assert.equal(classifyBrowserRequest(req("https://www.ebay.com/sch/i.html", {
    resourceType: "document", isNavigationRequest: true, method: "POST",
  }), origin), "same-origin");
});
test("public HTTPS CDN resources are permitted without permitting external navigation", () => {
  for (const type of ["script", "stylesheet", "image", "font", "xhr", "fetch"]) {
    assert.equal(classifyBrowserRequest(req("https://cdn.ebaystatic.com/app.js", {
      resourceType: type,
    }), origin), "public-subresource");
  }
  assert.equal(classifyBrowserRequest(req("https://cdn.ebaystatic.com/app.js", {
    resourceType: "document", isNavigationRequest: true,
  }), origin), "blocked");
});
test("cross-site POSTs, insecure resources and local/private destinations remain blocked", () => {
  for (const url of [
    "http://cdn.ebaystatic.com/app.js",
    "http://127.0.0.1:9876/app.js",
    "https://127.0.0.1/app.js",
    "https://10.0.0.1/app.js",
    "https://[::1]/app.js",
    "https://localhost/app.js",
    "https://metadata.google.internal/app.js",
    "https://device.local/app.js",
    "https://cdn.example.test/app.js",
    "https://cdn.ebaystatic.com:8443/app.js",
    "https://alice:secret@cdn.ebaystatic.com/app.js",
    "file:///etc/passwd",
  ]) {
    assert.equal(classifyBrowserRequest(req(url), origin), "blocked", url);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal(classifyBrowserRequest(req("https://cdn.ebaystatic.com/app.js", {
      method, resourceType: "fetch",
    }), origin), "blocked");
  }
});
test("unexpected request types and malformed URLs are blocked", () => {
  assert.equal(classifyBrowserRequest(req("https://cdn.ebaystatic.com/x", {
    resourceType: "document",
  }), origin), "blocked");
  assert.equal(classifyBrowserRequest(req("https://cdn.ebaystatic.com/x", {
    resourceType: "websocket",
  }), origin), "blocked");
  assert.equal(classifyBrowserRequest(req("not a URL"), origin), "blocked");
});
