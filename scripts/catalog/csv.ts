import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInflateRaw,crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface CsvInput { path: string; entry?: string; sha256: string }
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Streaming RFC 4180 reader. Quoted delimiters, escaped quotes and multiline cells survive chunk boundaries. */
export class CsvParser {
  private field=''; private row: string[]=[]; private quoted=false; private quotePending=false; private afterQuote=false; private skipLf=false;
  private bytes=0;
  push(chunk: string, final=false): string[][] {
    const rows: string[][]=[];
    const addField=()=>{ this.row.push(this.field); this.field=''; this.afterQuote=false; if (this.row.length>1000) throw new Error('CSV column limit exceeded'); };
    const addRow=()=>{ addField(); rows.push(this.row); this.row=[]; this.bytes=0; };
    for(const character of chunk){
      if(++this.bytes>1_000_000) throw new Error('CSV row exceeds 1 MB');
      if(this.skipLf){ this.skipLf=false; if(character==='\n') continue; }
      if(this.quotePending){ this.quotePending=false; if(character==='"'){this.field+='"';continue;} this.quoted=false;this.afterQuote=true; }
      if(this.quoted){ if(character==='"')this.quotePending=true;else this.field+=character;continue; }
      if(character===','){addField();continue;}
      if(character==='\n'||character==='\r'){addRow();if(character==='\r')this.skipLf=true;continue;}
      if(this.afterQuote) throw new Error('Unexpected text after a quoted CSV field');
      if(character==='"'){if(this.field.length)throw new Error('Unexpected quote inside unquoted CSV field');this.quoted=true;continue;}
      this.field+=character;
    }
    if(final){ if(this.quoted&&!this.quotePending)throw new Error('Unclosed CSV quote');if(this.field.length||this.row.length||this.quotePending)addRow(); }
    return rows;
  }
}

async function verifyDigest(input: CsvInput): Promise<void> {
  if(!/^[a-f0-9]{64}$/i.test(input.sha256))throw new Error('A SHA-256 digest is required for every public source file');
  const info=await stat(input.path);
  if(!info.isFile()||info.size>MAX_BYTES)throw new Error('Source must be a regular file no larger than 2 GiB');
  const hash=createHash('sha256');for await(const chunk of createReadStream(input.path))hash.update(chunk);
  if(hash.digest('hex')!==input.sha256.toLowerCase())throw new Error('Source SHA-256 mismatch');
}

async function zipStream(input: CsvInput): Promise<{stream:Readable;expectedSize:number;crc:number}> {
  const file=await open(input.path,'r');
  try{
    const size=(await file.stat()).size;
    const tail=Buffer.alloc(Math.min(size,65557));await file.read(tail,0,tail.length,size-tail.length);
    let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50 && i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0)throw new Error('ZIP end directory not found');
    if(tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0)throw new Error('Multi-disk ZIP is unsupported');
    const count=tail.readUInt16LE(end+10),directorySize=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
    if(count===65535||offset===0xffffffff||directorySize>16_000_000||offset+directorySize>size)throw new Error('Unsupported ZIP64 or oversized ZIP directory; provide extracted CSV');
    const directory=Buffer.alloc(directorySize);await file.read(directory,0,directorySize,offset);
    const candidates:{name:string;method:number;compressed:number;uncompressed:number;offset:number;flags:number;crc:number}[]=[];
    let cursor=0;
    for(let i=0;i<count;i++){
      if(cursor+46>directory.length||directory.readUInt32LE(cursor)!==0x02014b50)throw new Error('Invalid ZIP central directory');
      const nameLength=directory.readUInt16LE(cursor+28),extra=directory.readUInt16LE(cursor+30),comment=directory.readUInt16LE(cursor+32);
      const name=directory.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
      if(name.toLowerCase().endsWith('.csv')&&(!input.entry||name===input.entry))candidates.push({name,method:directory.readUInt16LE(cursor+10),compressed:directory.readUInt32LE(cursor+20),uncompressed:directory.readUInt32LE(cursor+24),offset:directory.readUInt32LE(cursor+42),flags:directory.readUInt16LE(cursor+8),crc:directory.readUInt32LE(cursor+16)});
      cursor+=46+nameLength+extra+comment;
    }
    if(candidates.length!==1)throw new Error('ZIP must contain one CSV or an explicit entry must be specified');
    const selected=candidates[0];
    if(selected.flags&1||![0,8].includes(selected.method)||selected.uncompressed>MAX_BYTES||selected.offset===0xffffffff)throw new Error('Encrypted, unsupported or oversized ZIP entry');
    const header=Buffer.alloc(30);await file.read(header,0,30,selected.offset);
    if(header.readUInt32LE(0)!==0x04034b50)throw new Error('Invalid ZIP local header');
    const start=selected.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28);
    if(start+selected.compressed>size)throw new Error('Truncated ZIP entry');
    const raw=createReadStream(input.path,{start,end:start+selected.compressed-1});
    if(selected.method===0)return {stream:raw,expectedSize:selected.uncompressed,crc:selected.crc};
    const inflated=createInflateRaw();raw.on('error',e=>inflated.destroy(e));return {stream:raw.pipe(inflated),expectedSize:selected.uncompressed,crc:selected.crc};
  } finally{await file.close();}
}

export async function* readCsv(input: CsvInput, requiredHeaders: string[]=[]): AsyncGenerator<Record<string,string>> {
  await verifyDigest(input);
  const zip=input.path.toLowerCase().endsWith('.zip')?await zipStream(input):undefined;
  const stream=zip?.stream??createReadStream(input.path);
  const parser=new CsvParser(),decoder=new TextDecoder('utf-8',{fatal:true});
  let header:string[]|undefined,bytes=0,count=0,checksum=0;
  const records=function*(rows:string[][]){for(const row of rows){
    if(row.length===1&&!row[0])continue;
    if(!header){header=row.map((h,i)=>(i===0?h.replace(/^\uFEFF/,''):h).trim());if(new Set(header).size!==header.length||header.some(h=>!h))throw new Error('Duplicate or empty CSV header');for(const h of requiredHeaders)if(!header.includes(h))throw new Error(`Missing required CMS column ${h}`);continue;}
    if(row.length!==header.length)throw new Error(`CSV row ${count+2} has the wrong column count`);
    if(++count>15_000_000)throw new Error('CSV row limit exceeded');
    yield Object.fromEntries(header.map((key,i)=>[key,row[i].trim()]));
  }};
  try{for await(const buffer of stream){bytes+=buffer.length;if(bytes>MAX_BYTES)throw new Error('Decompressed source exceeds 2 GiB');if(zip)checksum=crc32(buffer,checksum);yield*records(parser.push(decoder.decode(buffer,{stream:true})));}yield*records(parser.push(decoder.decode(),true));if(zip&&(bytes!==zip.expectedSize||checksum!==zip.crc))throw new Error('ZIP entry checksum or uncompressed size mismatch');if(!header)throw new Error('CSV has no header');}finally{stream.destroy();}
}
