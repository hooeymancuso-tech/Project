const http = require('http');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT = 3000;
const ENV_PATH = path.join(__dirname, '.env');
const MAX_BASE64_SIZE = 4 * 1024 * 1024; // 4MB base64 limit
const COMPRESS_THRESHOLD = 3 * 1024 * 1024; // compress if > 3MB

async function compressImageBase64(base64Str) {
  try {
    var sharp = require('sharp');
    var buffer = Buffer.from(base64Str, 'base64');
    var compressed = await sharp(buffer)
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return compressed.toString('base64');
  } catch(e) {
    console.log('[OCR] sharp压缩不可用，跳过:', e.message);
    return base64Str;
  }
}

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    content.split('\n').forEach(function(line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.substring(0, eqIdx).trim();
        let val = line.substring(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    });
  }
  return env;
}

function getAliyunConfig() {
  const env = loadEnv();
  var appCode = process.env.ALIYUN_OCR_APPCODE || env.ALIYUN_OCR_APPCODE || '';
  var isConfigured = appCode && appCode !== '你的AppCode' && appCode.length > 10;
  return {
    appCode: appCode,
    ocrUrl: process.env.ALIYUN_OCR_URL || env.ALIYUN_OCR_URL || 'https://multcommon.market.alicloudapi.com/ocrservice/mixedMultiCommon',
    isConfigured: !!isConfigured
  };
}

function callAliyunOCR(imageBase64, fileType) {
  return new Promise(function(resolve, reject) {
    const config = getAliyunConfig();
    if (!config.isConfigured) {
      return reject(new Error('未配置 ALIYUN_OCR_APPCODE，请在 .env 文件中设置真实的AppCode'));
    }

    const requestBody = JSON.stringify({ img: imageBase64 });

    const url = new URL(config.ocrUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': 'APPCODE ' + config.appCode,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody, 'utf8')
      }
    };

    const https = url.protocol === 'https:' ? require('https') : require('http');
    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode === 200) {
          try {
            var parsed = JSON.parse(data);
            if (parsed.error) {
              var code = parsed.error.code || 'unknown';
              var msg = parsed.error.message || JSON.stringify(parsed.error);
              var userMsg;
              if (code === '1210') userMsg = '图片格式无法识别，请上传清晰的发票图片（PNG/JPG/PDF）';
              else if (code === '1211') userMsg = '图片内容识别失败，请确保包含完整发票';
              else userMsg = 'OCR错误(' + code + '): ' + msg;
              return reject(new Error(userMsg));
            }
            resolve(parsed);
          } catch(e) {
            reject(new Error('OCR接口返回数据解析失败: ' + data.substring(0, 200)));
          }
        } else {
          let errMsg = 'OCR接口返回HTTP ' + res.statusCode;
          if (res.statusCode === 400) errMsg = 'OCR识别失败：请求参数格式错误，请检查文件格式或OCR接口配置';
          else if (res.statusCode === 401 || res.statusCode === 403) errMsg = 'OCR识别失败：接口鉴权失败，请检查AppCode或API Key';
          else if (res.statusCode === 429) errMsg = 'OCR识别失败：请求频率超限，请稍后重试';
          else if (res.statusCode >= 500) errMsg = 'OCR识别失败：服务端错误，请稍后重试';
          reject(new Error(errMsg + ' (' + data.substring(0, 100) + ')'));
        }
      });
    });

    req.on('error', function(e) {
      reject(new Error('OCR接口网络错误: ' + e.message));
    });

    req.write(requestBody);
    req.end();
  });
}

function parseOcrResult(aliyunResult) {
  var fields = {};

  // 混贴票证 API 返回 subMsgs 格式（可能在 Data 内或顶层）
  var subMsgs = null;
  if (aliyunResult) {
    if (aliyunResult.Data && aliyunResult.Data.subMsgs) {
      subMsgs = aliyunResult.Data.subMsgs;
    } else if (aliyunResult.subMsgs) {
      subMsgs = aliyunResult.subMsgs;
    } else if (aliyunResult.data && aliyunResult.data.subMsgs) {
      subMsgs = aliyunResult.data.subMsgs;
    }
  }

  if (subMsgs && subMsgs.length > 0) {
    var first = subMsgs[0];
    var d = first.result ? (first.result.data || first.result) : first;

    if (d) {
      // 云市场混贴票证 API 字段名映射（中文键名 → 英文键名）
      fields.invoiceType = d['发票类型'] || d.invoiceType || d['标题'] || d.title || first.type || '';
      fields.invoiceNumber = d['发票号码'] || d.invoiceNumber || '';
      fields.invoiceCode = d['发票代码'] || d.invoiceCode || '';
      fields.invoiceDate = d['开票日期'] || d.invoiceDate || '';
      fields.sellerName = d['销售方名称'] || d.sellerName || '';
      fields.buyerName = d['受票方名称'] || d['购买方名称'] || d.purchaserName || d.buyerName || '';
      fields.amount = d['不含税金额'] || d.invoiceAmountPreTax || d.amount || '';
      fields.taxAmount = d['发票税额'] || d.invoiceTax || d.taxAmount || '';
      fields.totalAmount = d['发票金额'] || d.totalAmount || '';
      fields.checkCode = d['校验码'] || d.checkCode || '';
      fields.buyerTaxId = d['受票方税号'] || d['购买方税号'] || d.purchaserTaxNumber || d.buyerTaxId || '';
      fields.invoiceTypeDetected = first.type || '';
      fields.remark = d['备注'] || '';
    }

    // 清理空值
    Object.keys(fields).forEach(function(k) {
      if (!fields[k]) delete fields[k];
    });

    return fields;
  }

  // Fallback: prism_wordsInfo 通用文字识别格式
  if (aliyunResult && aliyunResult.prism_wordsInfo) {
    aliyunResult.prism_wordsInfo.forEach(function(item) {
      if (item.word) {
        var word = item.word;
        if (word.indexOf('发票类型') >= 0 || word.indexOf('发票种类') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.invoiceType = val;
        } else if (word.indexOf('发票号码') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.invoiceNumber = val;
        } else if (word.indexOf('发票代码') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.invoiceCode = val;
        } else if (word.indexOf('开票日期') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.invoiceDate = val;
        } else if (word.indexOf('销售方') >= 0 && word.indexOf('名称') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.sellerName = val;
        } else if (word.indexOf('购买方') >= 0 && word.indexOf('名称') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.buyerName = val;
        } else if (word.indexOf('金额') >= 0 && word.indexOf('税') < 0 && word.indexOf('合计') < 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.amount = val;
        } else if (word.indexOf('税额') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.taxAmount = val;
        } else if (word.indexOf('价税合计') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.totalAmount = val;
        } else if (word.indexOf('校验码') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.checkCode = val;
        } else if (word.indexOf('购方税号') >= 0 || word.indexOf('纳税人识别号') >= 0) {
          var val = word.split(/[：:]/).slice(1).join(':').trim();
          if (val) fields.buyerTaxId = val;
        }
      }
    });
  }
  return fields;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

const server = http.createServer(function(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // OCR status endpoint
  if (req.method === 'GET' && req.url === '/api/ocr/status') {
    var config = getAliyunConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, configured: config.isConfigured }));
    return;
  }

  // OCR proxy endpoint
  if (req.method === 'POST' && req.url === '/api/ocr') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        var parsed = JSON.parse(body);
        if (!parsed.imageBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '缺少 imageBase64 参数' }));
          return;
        }

        var imgBase64 = parsed.imageBase64;
        if (imgBase64.length > MAX_BASE64_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '图片过大（超过4MB），请上传更小的图片' }));
          return;
        }

        console.log('[OCR] 收到请求, base64长度:', imgBase64.length, '文件类型:', parsed.fileType);

        if (imgBase64.length > COMPRESS_THRESHOLD) {
          console.log('[OCR] 图片较大，尝试压缩...');
          imgBase64 = await compressImageBase64(imgBase64);
          console.log('[OCR] 压缩后长度:', imgBase64.length);
        }

        var aliyunResult = await callAliyunOCR(imgBase64, parsed.fileType || 'image/png');
        var parsedFields = parseOcrResult(aliyunResult);

        console.log('[OCR] 识别成功, 提取字段数:', Object.keys(parsedFields).length);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: parsedFields, raw: aliyunResult }));
      } catch(e) {
        console.error('[OCR] 失败:', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Static file serving
  var filePath = req.url === '/' ? '/费用报销智能问答及预审助手.html' : req.url;
  filePath = path.join(__dirname, filePath.split('?')[0]);

  // Security: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    var contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, function() {
  console.log('========================================');
  console.log('  费用报销智能问答及预审助手 - 后端服务');
  console.log('========================================');
  console.log('  服务地址: http://localhost:' + PORT);
  console.log('  OCR代理: POST http://localhost:' + PORT + '/api/ocr');
  console.log('');
  var config = getAliyunConfig();
  if (config.isConfigured) {
    console.log('  阿里云OCR AppCode: 已配置 (' + config.appCode.substring(0, 4) + '****)');
    console.log('  阿里云OCR URL: ' + config.ocrUrl);
  } else {
    console.log('  阿里云OCR AppCode: 未配置');
    console.log('  请在 .env 文件中设置 ALIYUN_OCR_APPCODE=你的真实AppCode');
  }
  console.log('========================================');
});
