// A LumixCamera whose HTTP requests are answered by a script, for tests.
import { LumixCamera } from '../../src/server/lumix.js';

export const OK = '<?xml version="1.0" encoding="UTF-8"?>\r\n<camrply><result>ok</result></camrply>';
export const BUSY = '<?xml version="1.0" encoding="UTF-8"?>\r\n<camrply><result>err_busy</result></camrply>';

export function contentInfo(count) {
  return `<camrply><result>ok</result><current_position>${count - 1}</current_position><total_content_number>${count}</total_content_number></camrply>`;
}

export function settingValue(type, value) {
  return `<camrply><result>ok</result><settingvalue ${type}="${value}"></settingvalue></camrply>`;
}

export const BROWSE_RESPONSE =
  '<s:Envelope><s:Body><u:BrowseResponse><Result>' +
  '&lt;DIDL-Lite&gt;&lt;item id="1" &gt;' +
  '&lt;res protocolInfo="http-get:*:application/octet-stream;PANASONIC.COM_PN=CAM_RAW_JPG"&gt;http://192.168.54.1:50001/DO1100135.JPG&lt;/res&gt;' +
  '&lt;res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_TN"&gt;http://192.168.54.1:50001/DT1100135.JPG&lt;/res&gt;' +
  '&lt;res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_MED"&gt;http://192.168.54.1:50001/DL1100135.JPG&lt;/res&gt;' +
  '&lt;res protocolInfo="http-get:*:application/octet-stream;PANASONIC.COM_PN=CAM_RAW"&gt;http://192.168.54.1:50001/DO1100135.RW2&lt;/res&gt;' +
  '&lt;/item&gt;&lt;/DIDL-Lite&gt;</Result></u:BrowseResponse></s:Body></s:Envelope>';

// respond(query) returns the answer text, or a promise of it. The query is the
// part after "cam.cgi?", or "<METHOD> <url>" for other requests. Every query
// is recorded in order.
export function scriptedCamera(respond) {
  const queries = [];
  const fetchFunction = async (url, options = {}) => {
    const query = url.includes('cam.cgi?') ? url.split('cam.cgi?')[1] : `${options.method ?? 'GET'} ${url}`;
    queries.push(query);
    return new Response(await respond(query));
  };
  return { camera: new LumixCamera({ fetchFunction, pollIntervalMilliseconds: 0 }), queries };
}
