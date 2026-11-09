/**
 * Anti-corruption layer, part 2: SOAP 1.1 envelopes. Requests are built by hand
 * (no WSDL fetch at cold start); responses are parsed with fast-xml-parser.
 */
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { LegacyFaultError, UpstreamUnavailableError } from '../lib/errors';

export const RESLINK_NS = 'urn:reslink:v2';

const builder = new XMLBuilder({ suppressEmptyNode: false, format: false });

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false, // keep "0042900" and "AC0105" as strings
  trimValues: false, // keep "YYZ  " exactly as sent; codes.ts does the trimming
  isArray: (name) => name === 'ROW',
});

type XmlValue = string | number | XmlObject | XmlValue[];
interface XmlObject {
  [k: string]: XmlValue;
}

function prefix(obj: XmlObject): XmlObject {
  const out: XmlObject = {};
  for (const [k, v] of Object.entries(obj)) {
    out[`r:${k}`] = typeof v === 'object' && !Array.isArray(v) ? prefix(v as XmlObject) : v;
  }
  return out;
}

export function buildEnvelope(operation: string, body: XmlObject, auth: { user: string; password: string }): string {
  const header = builder.build({ 'r:AuthHeader': { 'r:USR': auth.user, 'r:PWD': auth.password } });
  const payload = builder.build({ [`r:${operation}Request`]: prefix(body) });
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:r="${RESLINK_NS}">` +
    `<soapenv:Header>${header}</soapenv:Header>` +
    `<soapenv:Body>${payload}</soapenv:Body>` +
    '</soapenv:Envelope>'
  );
}

/** Deep-clean whitespace-only text nodes that trimValues:false leaves around elements. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '#text' && typeof val === 'string' && val.trim() === '') continue;
      out[k] = clean(val);
    }
    return out;
  }
  return v;
}

/**
 * Parses a SOAP response. Returns the content of `<{operation}Response>`, or
 * throws LegacyFaultError for a soap:Fault, or UpstreamUnavailableError when the
 * payload is not a SOAP envelope we understand (HTML error pages, truncation...).
 */
export function parseResponse(operation: string, xml: string): Record<string, unknown> {
  // The parser is lenient: a truncated body would parse into a partial (wrong!) quote. Validate first.
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new UpstreamUnavailableError(`malformed legacy response: ${valid.err.msg}`);
  let doc: Record<string, unknown>;
  try {
    doc = clean(parser.parse(xml)) as Record<string, unknown>;
  } catch (err) {
    throw new UpstreamUnavailableError(`unparseable legacy response: ${(err as Error).message}`);
  }
  const body = (doc.Envelope as Record<string, unknown> | undefined)?.Body as Record<string, unknown> | undefined;
  if (!body) throw new UpstreamUnavailableError('legacy response is not a SOAP envelope');

  const faultNode = body.Fault as Record<string, unknown> | undefined;
  if (faultNode) {
    const detail = (faultNode.detail as Record<string, unknown> | undefined)?.ResError as Record<string, string> | undefined;
    const code = Number(String(detail?.ERRCD ?? '').trim());
    if (!Number.isInteger(code) || code <= 0) {
      throw new UpstreamUnavailableError(`legacy fault without error code: ${String(faultNode.faultstring ?? '')}`);
    }
    throw new LegacyFaultError(code, String(detail?.ERRTX ?? '').trim());
  }

  const result = body[`${operation}Response`] as Record<string, unknown> | undefined;
  if (!result) throw new UpstreamUnavailableError(`legacy response has no ${operation}Response element`);
  return result;
}

export function text(node: Record<string, unknown>, key: string): string {
  const v = node[key];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && '#text' in (v as object)) return String((v as Record<string, unknown>)['#text']);
  return String(v);
}
