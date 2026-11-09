async function sha256(bytes) {
    if (globalThis.crypto?.subtle) return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    const constants = [], initial = [];
    for (let n=2; constants.length<64; n++) {
        let prime=true;
        for(let d=2;d*d<=n;d++)if(n%d===0){prime=false;break;}
        if(prime){if(initial.length<8)initial.push((Math.sqrt(n)%1*4294967296)|0);constants.push((Math.cbrt(n)%1*4294967296)|0);}
    }
    const rotate=(n,b)=>(n>>>b)|(n<<(32-b));
    const length=Math.ceil((bytes.length+9)/64)*64, padded=new Uint8Array(length);
    padded.set(bytes);padded[bytes.length]=128;
    const view=new DataView(padded.buffer), bits=bytes.length*8;
    view.setUint32(length-8,Math.floor(bits/4294967296));view.setUint32(length-4,bits>>>0);
    const words=new Int32Array(64);
    for(let offset=0;offset<length;offset+=64){
        for(let i=0;i<16;i++)words[i]=view.getInt32(offset+i*4);
        for(let i=16;i<64;i++){
            const x=words[i-15],y=words[i-2];
            words[i]=(words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))|0;
        }
        let [a,b,c,d,e,f,g,h]=initial;
        for(let i=0;i<64;i++){
            const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])|0;
            const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;
            h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
        }
        [a,b,c,d,e,f,g,h].forEach((v,i)=>{initial[i]=(initial[i]+v)|0;});
        // Large photos should not freeze a phone while hashing on insecure HTTP.
        if(offset && offset%(1024*1024)===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    const result=new Uint8Array(32),output=new DataView(result.buffer);
    initial.forEach((n,i)=>output.setInt32(i*4,n));return result;
}

// Immutable, content-addressed files in SillyTavern's authenticated user files.
// Only replace an inline value after an exact read-back verification succeeds.
const bytesToBase64 = bytes => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
};
export function createAssetStore({ prefix, headers, request = (...args) => fetch(...args) }) {
    if (!/^[a-z0-9-]+$/.test(prefix)) throw Error('Invalid asset prefix');
    const pattern = new RegExp(`^/?user/files/${prefix}-[a-f0-9]{64}\\.(txt|png|jpg|webp|gif)$`);
    const checked = url => {
        if (typeof url !== 'string' || !pattern.test(url)) throw Error('보관 파일 경로를 확인할 수 없어.');
        return '/' + url.replace(/^\//, '');
    };
    async function fetchTimed(url, options = {}, consume = response => response) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
        try { return await consume(await request(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal })); }
        finally { clearTimeout(timer); }
    }
    async function readBytes(url, missing = false) {
        return fetchTimed(checked(url), {}, async response => {
            if (missing && response.status === 404) return null;
            if (!response.ok) throw Error(`보관 파일 읽기 실패 (${response.status})`);
            return new Uint8Array(await response.arrayBuffer());
        });
    }
    const equal = (a, b) => a && a.length === b.length && a.every((v, i) => v === b[i]);
    async function put(bytes, extension) {
        const digest = [...new Uint8Array(await sha256(bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
        const name = `${prefix}-${digest}.${extension}`, url = `/user/files/${name}`;
        const existing = await readBytes(url, true);
        if (existing !== null) {
            if (!equal(existing, bytes)) throw Error('같은 이름의 보관 파일이 원본과 달라. 기존 자료를 유지할게.');
            return url;
        }
        const result = await fetchTimed('/api/files/upload', { method: 'POST', headers: headers(),
            body: JSON.stringify({ name, data: bytesToBase64(bytes) }) }, async response => {
            if (!response.ok) throw Error(`보관 파일 저장 실패 (${response.status})`);
            return response.json();
        });
        if (checked(result.path) !== url || !equal(await readBytes(url), bytes)) throw Error('보관 파일 검증 실패. 원본은 유지돼.');
        return url;
    }
    return {
        owns: url => typeof url === 'string' && pattern.test(url),
        putText: text => put(new TextEncoder().encode(text), 'txt'),
        async text(url) { return new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(url)); },
        async image(dataUrl) {
            const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
            if (!match) throw Error('지원하지 않는 사진 형식이야. 원본은 유지돼.');
            const bytes = Uint8Array.from(atob(match[2].replace(/\s/g, '')), c => c.charCodeAt(0));
            return put(bytes, match[1] === 'jpeg' ? 'jpg' : match[1]);
        },
        async remove(url) {
            const safe = checked(url);
            const response = await fetchTimed('/api/files/delete', { method: 'POST', headers: headers(), body: JSON.stringify({ path: safe.slice(1) }) });
            if (!response.ok && response.status !== 404) throw Error('보관 파일을 삭제하지 못했어.');
        },
    };
}

export async function offloadText(record, field, assets) {
    if (typeof record[field] !== 'string' || !record[field]) return false;
    const original = record[field];
    const ref = await assets.putText(original);
    // If an editor changed the value during upload, leave the new text intact.
    if (record[field] !== original) return false;
    record[field + 'File'] = ref;
    record[field + 'Preview'] = original.slice(0, 80);
    delete record[field];
    return true;
}

export async function readText(record, field, assets) {
    if (typeof record[field] === 'string') return record[field];
    if (record[field + 'File']) return assets.text(record[field + 'File']);
    throw Error('보관된 본문을 찾을 수 없어.');
}

// Pause bulk migration while the page is hidden; yield between records on phones.
export async function migrationTurn() {
    if (globalThis.document?.hidden) await new Promise(resolve => {
        const visible = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', visible); resolve(); } };
        document.addEventListener('visibilitychange', visible); visible();
    });
    await new Promise(resolve => setTimeout(resolve, 0));
}
