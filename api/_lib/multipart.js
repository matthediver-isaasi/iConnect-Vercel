export async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    let body = [];
    let boundary = null;
    
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (boundaryMatch) {
      boundary = boundaryMatch[1] || boundaryMatch[2];
    }
    
    if (!boundary) {
      return reject(new Error('No boundary found in content-type'));
    }
    
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(body);
        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const parts = [];
        let start = 0;
        
        while (true) {
          const idx = buffer.indexOf(boundaryBuffer, start);
          if (idx === -1) break;
          if (start > 0) {
            parts.push(buffer.slice(start, idx - 2));
          }
          start = idx + boundaryBuffer.length + 2;
        }
        
        let file = null;
        const fields = {};
        
        for (const part of parts) {
          if (part.length < 4) continue;
          
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          
          const headers = part.slice(0, headerEnd).toString();
          const content = part.slice(headerEnd + 4);
          
          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
          
          if (nameMatch) {
            const fieldName = nameMatch[1];
            
            if (filenameMatch && fieldName === 'file') {
              // Only remove trailing CRLF if present, otherwise keep full content
              let fileBuffer = content;
              if (content.length >= 2 && 
                  content[content.length - 2] === 13 && 
                  content[content.length - 1] === 10) {
                // Remove trailing \r\n
                fileBuffer = content.slice(0, content.length - 2);
              } else if (content.length >= 1 && content[content.length - 1] === 10) {
                // Remove trailing \n only
                fileBuffer = content.slice(0, content.length - 1);
              }
              
              file = {
                originalname: filenameMatch[1],
                mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
                buffer: fileBuffer,
                size: fileBuffer.length
              };
            } else {
              fields[fieldName] = content.toString().trim().replace(/\r\n$/, '');
            }
          }
        }
        
        resolve({ file, fields });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
