// all uses of "buffer" refer to the structure represented by b4a: 
// i.e. a nodejs buffer if running nodejs, or a Uint8Array in the web
const b4a = require("b4a")
const constants = require("./constants.js")
const varint = require("varint")
const crypto = require("./cryptography.js")

// TODO (2023-01-10):
// * in the create methods: improve their resiliency by detecting when the pre-allocated buffer will not be large enough, and reallocatIe a larger buffer
// * reserve 4 bytes between `req_id` and `ttl`
//  in requests, and also in responses after `req_id` for circuits
// * in create methods: guard against invalid values for arguments 

// TODO (2023-01-11): validity checking of arguments 
// * reqid is a buffer of length REQID_SIZE
// * numbers: ttl, limit, updates, timeStart, timeEnd
// * hashes is a list of HASH_SIZE buffers
// * strings: channel, topic, text

// TODO (2023-01-11): regarding byte size of a string
// is it enough to simply do str.length to get the correct byte size?

// TODO (2023-01-11): 
// would like to abstract away offset += varint.decode.bytes in case we swap library / opt for self-authored standard

const HASHES_EXPECTED = new Error("expected hashes to contain an array of hash-sized buffers")
function bufferExpected (param, size) {
  return new Error(`expected ${param} to be a buffer of size ${size}`)
}
function integerExpected (param) {
  return new Error(`expected ${param} to be an integer`)
}
function stringExpected (param) {
  return new Error(`expected ${param} to be a string`)
}

class HASH_RESPONSE {
  static create(reqid, hashes) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    if (!isArrayHashes(hashes)) { throw HASHES_EXPECTED }
    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.HASH_RESPONSE, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, offset)
    // 3. write amount of hashes (hash_count varint)
    offset += writeVarint(hashes.length, frame, offset)
    // 4. write the hashes themselves
    hashes.forEach(hash => {
      offset += hash.copy(frame, offset)
    })
    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }
  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid, hashes }
  static toJSON(buf) {
    let offset = 0
    // 1. get msgLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.HASH_RESPONSE) {
      throw new Error("decoded msgType is not of expected type (constants.HASH_RESPONSE)")
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    offset += constants.REQID_SIZE
    // 4. get hashCount
    const hashCount = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 5. use hashCount to slice out the hashes
    let hashes = []
    for (let i = 0; i < hashCount; i++) {
      hashes.push(buf.slice(offset, offset + constants.HASH_SIZE))
      offset += constants.HASH_SIZE
    }
    if (!isArrayHashes(hashes)) { throw HASHES_EXPECTED }

    return { msgLen, msgType, reqid, hashes }
  }
}

class DATA_RESPONSE {
  static create(reqid, arrdata) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    // TODO (2023-01-11): sanitize arr of data
    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.DATA_RESPONSE, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, offset)
    // 3. exhaust array of data
    for (let i = 0; i < arrdata.length; i++) {
      // 3.1 first write dataLen 
      console.log(arrdata[i], arrdata[i].length)
      offset += writeVarint(arrdata[i].length, frame, offset)
      // 3.2 then write the data
      offset += arrdata[i].copy(frame, offset)
    }
    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }
  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid, data}
  static toJSON(buf) {
    let offset = 0
    let msgLenBytes
    // 1. get msgLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    msgLenBytes = varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.DATA_RESPONSE) {
      throw new Error("decoded msgType is not of expected type (constants.DATA_RESPONSE)")
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    offset += constants.REQID_SIZE
    // 4. remaining buffer consists of [dataLen, data] segments
    // read until it runs out
    let data = []
    // msgLen tells us the number of bytes in the remaining cablegram i.e. *excluding* msgLen, 
    // so we need to account for that by adding msgLenBytes
    let remaining = msgLen - offset + msgLenBytes
    while (remaining > 0) {
      const dataLen = decodeVarintSlice(buf, offset)
      offset += varint.decode.bytes
      // 5. use dataLen to slice out the hashes
      data.push(buf.slice(offset, offset + dataLen))
      offset += dataLen
      
      remaining = msgLen - offset + msgLenBytes
    }

    return { msgLen, msgType, reqid, data }
  }
}

class HASH_REQUEST {
  // constructs a cablegram buffer using the incoming arguments
  static create(reqid, ttl, hashes) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    if (!isInteger(ttl)) { throw integerExpected("ttl") }
    if (!isArrayHashes(hashes)) { throw HASHES_EXPECTED }

    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.HASH_REQUEST, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, offset)
    // 3. write ttl
    offset += writeVarint(ttl, frame, offset)
    // 4. write amount of hashes (hash_count varint)
    offset += writeVarint(hashes.length, frame, offset)
    // 5. write the hashes themselves
    hashes.forEach(hash => {
      offset += hash.copy(frame, offset)
    })
    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }

  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid, ttl, hashes }
  static toJSON(buf) {
    let offset = 0
    // 1. get msgLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.HASH_REQUEST) {
      throw new Error("decoded msgType is not of expected type (constants.HASH_REQUEST)")
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    offset += constants.REQID_SIZE
    // 4. get ttl
    const ttl = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 5. get hashCount
    const hashCount = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use hashCount to slice out the hashes
    let hashes = []
    for (let i = 0; i < hashCount; i++) {
      hashes.push(buf.slice(offset, offset + constants.HASH_SIZE))
      offset += constants.HASH_SIZE
    }
    if (!isArrayHashes(hashes)) { throw HASHES_EXPECTED }

    return { msgLen, msgType, reqid, ttl, hashes }
  }
}

class CANCEL_REQUEST {
  // constructs a cablegram buffer using the incoming arguments
  static create(reqid) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }

    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.CANCEL_REQUEST, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, varint.encode.bytes)

    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }

  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid }
  static toJSON(buf) {
    let offset = 0
    // 1. get mshLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.CANCEL_REQUEST) {
      throw new Error("decoded msgType is not of expected type (constants.CANCEL_REQUEST)")
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    offset += constants.REQID_SIZE

    return { msgLen, msgType, reqid }
  }
}

class TIME_RANGE_REQUEST {
  static create(reqid, ttl, channel, timeStart, timeEnd, limit) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    if (!isInteger(ttl)) { throw integerExpected("ttl") }
    if (!isString(channel)) { throw stringExpected("channel") }
    if (!isInteger(timeStart)) { throw integerExpected("timeStart") }
    if (!isInteger(timeEnd)) { throw integerExpected("timeEnd") }
    if (!isInteger(limit)) { throw integerExpected("limit") }

    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.TIME_RANGE_REQUEST, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, offset)
    // 3. write ttl
    offset += writeVarint(ttl, frame, offset)
    // 4. write channel_size
    offset += writeVarint(channel.length, frame, offset)
    // 5. write the channel
    offset += b4a.from(channel).copy(frame, offset)
    // 6. write time_start
    offset += writeVarint(timeStart, frame, offset)
    // 7. write time_end
    offset += writeVarint(timeEnd, frame, offset)
    // 8. write limit
    offset += writeVarint(limit, frame, offset)
    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }
  
  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid, ttl, channel, timeStart, timeEnd, limit }
  static toJSON(buf) {
    let offset = 0
    // 1. get msgLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.TIME_RANGE_REQUEST) {
      return new Error(`"decoded msgType (${msgType}) is not of expected type (constants.TIME_RANGE_REQUEST)`)
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    offset += constants.REQID_SIZE
    // 4. get ttl
    const ttl = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 5. get channelSize
    const channelSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use channelSize to slice out the channel
    const channel = buf.slice(offset, offset + channelSize).toString()
    offset += channelSize
    // 7. get timeStart
    const timeStart = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 8. get timeEnd
    const timeEnd = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 9. get limit
    const limit = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes

    return { msgLen, msgType, reqid, ttl, channel, timeStart, timeEnd, limit }
  }
}

class CHANNEL_STATE_REQUEST {
  static create(reqid, ttl, channel, limit, updates) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    if (!isInteger(ttl)) { throw integerExpected("ttl") }
    if (!isString(channel)) { throw stringExpected("channel") }
    if (!isInteger(limit)) { throw integerExpected("limit") }
    if (!isInteger(updates)) { throw integerExpected("updates") }

    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.CHANNEL_STATE_REQUEST, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, offset)
    // 3. write ttl
    offset += writeVarint(ttl, frame, offset)
    // 4. write channel_size
    offset += writeVarint(channel.length, frame, offset)
    // 5. write the channel
    offset += b4a.from(channel).copy(frame, offset)
    // 6. write limit 
    offset += writeVarint(limit, frame, offset)
    // 7. write updates
    offset += writeVarint(updates, frame, offset)
    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }
  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid, ttl, channel, limit, updates }
  static toJSON(buf) {
    let offset = 0
    // 1. get msgLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.CHANNEL_STATE_REQUEST) {
      return new Error(`"decoded msgType (${msgType}) is not of expected type (constants.CHANNEL_STATE_REQUEST)`)
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    offset += constants.REQID_SIZE
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    // 4. get ttl
    const ttl = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 5. get channelSize
    const channelSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use channelSize to slice out channel
    const channel = buf.slice(offset, offset + channelSize).toString()
    offset += channelSize
    // 7. get limit
    const limit = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 8. get updates
    const updates = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes

    return { msgLen, msgType, reqid, ttl, channel, limit, updates }
  }
}

class CHANNEL_LIST_REQUEST {
  static create(reqid, ttl, limit) {
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    if (!isInteger(ttl)) { throw integerExpected("ttl") }
    if (!isInteger(limit)) { throw integerExpected("limit") }

    // allocate default-sized buffer
    let frame = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    let offset = 0
    // 1. write message type
    offset += writeVarint(constants.CHANNEL_LIST_REQUEST, frame, offset)
    // 2. write reqid
    offset += reqid.copy(frame, offset)
    // 3. write ttl
    offset += writeVarint(ttl, frame, offset)
    // 4. write limit 
    offset += writeVarint(limit, frame, offset)
    // resize buffer, since we have written everything except msglen
    frame = frame.slice(0, offset)
    return prependMsgLen(frame)
  }
  // takes a cablegram buffer and returns the json object: 
  // { msgLen, msgType, reqid, ttl, limit }
  static toJSON(buf) {
    let offset = 0
    // 1. get msgLen
    const msgLen = decodeVarintSlice(buf, 0)
    offset += varint.decode.bytes
    if (!isBufferSize(buf.slice(offset), msgLen)) { throw bufferExpected("remaining buf", msgLen) }
    // 2. get msgType
    const msgType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (msgType !== constants.CHANNEL_LIST_REQUEST) {
      return new Error(`"decoded msgType (${msgType}) is not of expected type (constants.CHANNEL_LIST_REQUEST)`)
    }
    // 3. get reqid
    const reqid = buf.slice(offset, offset+constants.REQID_SIZE)
    offset += constants.REQID_SIZE
    if (!isBufferSize(reqid, constants.REQID_SIZE)) { throw bufferExpected("reqid", constants.REQID_SIZE) }
    // 4. get ttl
    const ttl = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 5. get limit
    const limit = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes

    return { msgLen, msgType, reqid, ttl, limit }
  }
}

class TEXT_POST {
  static create(publicKey, secretKey, link, channel, timestamp, text) {
    if (!isBufferSize(publicKey, constants.PUBLICKEY_SIZE)) { throw bufferExpected("publicKey", constants.PUBLICKEY_SIZE) }
    if (!isBufferSize(secretKey, constants.SECRETKEY_SIZE)) { throw bufferExpected("secretKey", constants.SECRETKEY_SIZE) }
    if (!isBufferSize(link, constants.HASH_SIZE)) { throw bufferExpected("link", constants.HASH_SIZE) }
    if (!isString(channel)) { throw stringExpected("channel") }
    if (!isInteger(timestamp)) { throw integerExpected("timestamp") }
    if (!isString(text)) { throw stringExpected("text") }
    
    let offset = 0
    const message = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    // 1. write public key
    offset += publicKey.copy(message, 0)
    // 2. make space for signature, which is done last of all.
    offset += constants.SIGNATURE_SIZE
    // 3. write link, which is represents a hash i.e. a buffer
    offset += link.copy(message, offset)
    // 4. write postType
    offset += writeVarint(constants.TEXT_POST, message, offset)
    // 5. write channelSize
    offset += writeVarint(channel.length, message, offset)
    // 6. write the channel
    offset += b4a.from(channel).copy(message, offset)
    // 7. write timestamp
    offset += writeVarint(timestamp, message, offset)
    // 8. write textSize
    offset += writeVarint(text.length, message, offset)
    // 9. write the text
    offset += b4a.from(text).copy(message, offset)
    // now, time to make a signature
    const signaturePayload = message.slice(constants.PUBLICKEY_SIZE, offset)
    const payload = message.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE, offset)
    crypto.sign(signaturePayload, payload, secretKey)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }

    return message.slice(0, offset)
  }

  static toJSON(buf) {
    // { publicKey, signature, link, postType, channel, timestamp, text }
    let offset = 0
    // 1. get publicKey
    const publicKey = buf.slice(0, constants.PUBLICKEY_SIZE)
    offset += constants.PUBLICKEY_SIZE
    // 2. get signature
    const signature = buf.slice(offset, offset + constants.SIGNATURE_SIZE)
    offset += constants.SIGNATURE_SIZE
    // verify signature is correct
    const signaturePayload = buf.slice(constants.PUBLICKEY_SIZE)
    const payload = buf.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }
    // 3. get link
    const link = buf.slice(offset, offset + constants.HASH_SIZE)
    offset += constants.HASH_SIZE
    // 4. get postType
    const postType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (postType !== constants.TEXT_POST) {
      return new Error(`"decoded postType (${postType}) is not of expected type (constants.TEXT_POST)`)
    }
    // 5. get channelSize
    const channelSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use channelSize to get channel
    const channel = buf.slice(offset, offset + channelSize).toString()
    offset += channelSize
    // 7. get timestamp
    const timestamp = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 8. get textSize
    const textSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 9. use textSize to get text
    const text = buf.slice(offset, offset + textSize).toString()
    offset += textSize

    return { publicKey, signature, link, postType, channel, timestamp, text }
  }
}

class DELETE_POST {
  static create(publicKey, secretKey, link, timestamp, hash) {
    if (!isBufferSize(publicKey, constants.PUBLICKEY_SIZE)) { throw bufferExpected("publicKey", constants.PUBLICKEY_SIZE) }
    if (!isBufferSize(secretKey, constants.SECRETKEY_SIZE)) { throw bufferExpected("secretKey", constants.SECRETKEY_SIZE) }
    if (!isBufferSize(link, constants.HASH_SIZE)) { throw bufferExpected("link", constants.HASH_SIZE) }
    if (!isInteger(timestamp)) { throw integerExpected("timestamp") }
    if (!isBufferSize(hash, constants.HASH_SIZE)) { throw bufferExpected("hash", constants.HASH_SIZE) }
    
    let offset = 0
    const message = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    // 1. write public key
    offset += publicKey.copy(message, 0)
    // 2. make space for signature, which is done last of all.
    offset += constants.SIGNATURE_SIZE
    // 3. write link, which is represents a hash i.e. a buffer
    offset += link.copy(message, offset)
    // 4. write postType
    offset += writeVarint(constants.DELETE_POST, message, offset)
    // 5. write timestamp
    offset += writeVarint(timestamp, message, offset)
    // 6. write hash, which represents the hash of the post we are requesting peers to delete
    offset += hash.copy(message, offset)
    // now, time to make a signature
    const signaturePayload = message.slice(constants.PUBLICKEY_SIZE, offset)
    const payload = message.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE, offset)
    crypto.sign(signaturePayload, payload, secretKey)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }

    return message.slice(0, offset)
  }
  static toJSON(buf) {
    // { publicKey, signature, link, postType, timestamp, hash }
    let offset = 0
    // 1. get publicKey
    const publicKey = buf.slice(0, constants.PUBLICKEY_SIZE)
    offset += constants.PUBLICKEY_SIZE
    // 2. get signature
    const signature = buf.slice(offset, offset + constants.SIGNATURE_SIZE)
    offset += constants.SIGNATURE_SIZE
    // verify signature is correct
    const signaturePayload = buf.slice(constants.PUBLICKEY_SIZE)
    const payload = buf.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }
    // 3. get link
    const link = buf.slice(offset, offset + constants.HASH_SIZE)
    offset += constants.HASH_SIZE
    // 4. get postType
    const postType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (postType !== constants.DELETE_POST) {
      return new Error(`"decoded postType (${postType}) is not of expected type (constants.DELETE_POST)`)
    }
    // 5. get timestamp
    const timestamp = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. get hash
    const hash = buf.slice(offset, offset + constants.HASH_SIZE)
    offset += constants.HASH_SIZE

    return { publicKey, signature, link, postType, timestamp, hash }
  }
}
  
// intentionally left blank; will loop back to
// class INFO_POST {
//   static create(publicKey, link, timestamp) {}
//   static toJSON(buf) {}
// }


class TOPIC_POST {
  static create(publicKey, secretKey, link, channel, timestamp, topic) {
    if (!isBufferSize(publicKey, constants.PUBLICKEY_SIZE)) { throw bufferExpected("publicKey", constants.PUBLICKEY_SIZE) }
    if (!isBufferSize(secretKey, constants.SECRETKEY_SIZE)) { throw bufferExpected("secretKey", constants.SECRETKEY_SIZE) }
    if (!isBufferSize(link, constants.HASH_SIZE)) { throw bufferExpected("link", constants.HASH_SIZE) }
    if (!isString(channel)) { throw stringExpected("channel") }
    if (!isInteger(timestamp)) { throw integerExpected("timestamp") }
    if (!isString(topic)) { throw stringExpected("topic") }
    
    let offset = 0
    const message = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    // 1. write public key
    offset += publicKey.copy(message, 0)
    // 2. make space for signature, which is done last of all.
    offset += constants.SIGNATURE_SIZE
    // 3. write link, which is represents a hash i.e. a buffer
    offset += link.copy(message, offset)
    // 4. write postType
    offset += writeVarint(constants.TOPIC_POST, message, offset)
    // 5. write channelSize
    offset += writeVarint(channel.length, message, offset)
    // 6. write the channel
    offset += b4a.from(channel).copy(message, offset)
    // 7. write timestamp
    offset += writeVarint(timestamp, message, offset)
    // 8. write topicSize
    offset += writeVarint(topic.length, message, offset)
    // 9. write the topic
    offset += b4a.from(topic).copy(message, offset)
    // now, time to make a signature
    const signaturePayload = message.slice(constants.PUBLICKEY_SIZE, offset)
    const payload = message.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE, offset)
    crypto.sign(signaturePayload, payload, secretKey)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }

    return message.slice(0, offset)
  }

  static toJSON(buf) {
    // { publicKey, signature, link, postType, channel, timestamp, topic }
    let offset = 0
    // 1. get publicKey
    const publicKey = buf.slice(0, constants.PUBLICKEY_SIZE)
    offset += constants.PUBLICKEY_SIZE
    // 2. get signature
    const signature = buf.slice(offset, offset + constants.SIGNATURE_SIZE)
    offset += constants.SIGNATURE_SIZE
    // verify signature is correct
    const signaturePayload = buf.slice(constants.PUBLICKEY_SIZE)
    const payload = buf.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }
    // 3. get link
    const link = buf.slice(offset, offset + constants.HASH_SIZE)
    offset += constants.HASH_SIZE
    // 4. get postType
    const postType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (postType !== constants.TOPIC_POST) {
      return new Error(`"decoded postType (${postType}) is not of expected type (constants.TOPIC_POST)`)
    }
    // 5. get channelSize
    const channelSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use channelSize to get channel
    const channel = buf.slice(offset, offset + channelSize).toString()
    offset += channelSize
    // 7. get timestamp
    const timestamp = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 8. get topicSize
    const topicSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 9. use topicSize to get topic
    const topic = buf.slice(offset, offset + topicSize).toString()
    offset += topicSize

    return { publicKey, signature, link, postType, channel, timestamp, topic }
  }
}

class JOIN_POST {
  static create(publicKey, secretKey, link, channel, timestamp) {
    if (!isBufferSize(publicKey, constants.PUBLICKEY_SIZE)) { throw bufferExpected("publicKey", constants.PUBLICKEY_SIZE) }
    if (!isBufferSize(secretKey, constants.SECRETKEY_SIZE)) { throw bufferExpected("secretKey", constants.SECRETKEY_SIZE) }
    if (!isBufferSize(link, constants.HASH_SIZE)) { throw bufferExpected("link", constants.HASH_SIZE) }
    if (!isString(channel)) { throw stringExpected("channel") }
    if (!isInteger(timestamp)) { throw integerExpected("timestamp") }
    
    let offset = 0
    const message = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    // 1. write public key
    offset += publicKey.copy(message, 0)
    // 2. make space for signature, which is done last of all.
    offset += constants.SIGNATURE_SIZE
    // 3. write link, which is represents a hash i.e. a buffer
    offset += link.copy(message, offset)
    // 4. write postType
    offset += writeVarint(constants.JOIN_POST, message, offset)
    // 5. write channelSize
    offset += writeVarint(channel.length, message, offset)
    // 6. write the channel
    offset += b4a.from(channel).copy(message, offset)
    // 7. write timestamp
    offset += writeVarint(timestamp, message, offset)
    // now, time to make a signature
    const signaturePayload = message.slice(constants.PUBLICKEY_SIZE, offset)
    const payload = message.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE, offset)
    crypto.sign(signaturePayload, payload, secretKey)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }

    return message.slice(0, offset)
  }

  static toJSON(buf) {
    // { publicKey, signature, link, postType, channel, timestamp }
    let offset = 0
    // 1. get publicKey
    const publicKey = buf.slice(0, constants.PUBLICKEY_SIZE)
    offset += constants.PUBLICKEY_SIZE
    // 2. get signature
    const signature = buf.slice(offset, offset + constants.SIGNATURE_SIZE)
    offset += constants.SIGNATURE_SIZE
    // verify signature is correct
    const signaturePayload = buf.slice(constants.PUBLICKEY_SIZE)
    const payload = buf.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }
    // 3. get link
    const link = buf.slice(offset, offset + constants.HASH_SIZE)
    offset += constants.HASH_SIZE
    // 4. get postType
    const postType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (postType !== constants.JOIN_POST) {
      return new Error(`"decoded postType (${postType}) is not of expected type (constants.JOIN_POST)`)
    }
    // 5. get channelSize
    const channelSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use channelSize to get channel
    const channel = buf.slice(offset, offset + channelSize).toString()
    offset += channelSize
    // 7. get timestamp
    const timestamp = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes

    return { publicKey, signature, link, postType, channel, timestamp }
  }
}

class LEAVE_POST {
  static create(publicKey, secretKey, link, channel, timestamp) {
    if (!isBufferSize(publicKey, constants.PUBLICKEY_SIZE)) { throw bufferExpected("publicKey", constants.PUBLICKEY_SIZE) }
    if (!isBufferSize(secretKey, constants.SECRETKEY_SIZE)) { throw bufferExpected("secretKey", constants.SECRETKEY_SIZE) }
    if (!isBufferSize(link, constants.HASH_SIZE)) { throw bufferExpected("link", constants.HASH_SIZE) }
    if (!isString(channel)) { throw stringExpected("channel") }
    if (!isInteger(timestamp)) { throw integerExpected("timestamp") }
    
    let offset = 0
    const message = b4a.alloc(constants.DEFAULT_BUFFER_SIZE)
    // 1. write public key
    offset += publicKey.copy(message, 0)
    // 2. make space for signature, which is done last of all.
    offset += constants.SIGNATURE_SIZE
    // 3. write link, which is represents a hash i.e. a buffer
    offset += link.copy(message, offset)
    // 4. write postType
    offset += writeVarint(constants.LEAVE_POST, message, offset)
    // 5. write channelSize
    offset += writeVarint(channel.length, message, offset)
    // 6. write the channel
    offset += b4a.from(channel).copy(message, offset)
    // 7. write timestamp
    offset += writeVarint(timestamp, message, offset)
    // now, time to make a signature
    const signaturePayload = message.slice(constants.PUBLICKEY_SIZE, offset)
    const payload = message.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE, offset)
    crypto.sign(signaturePayload, payload, secretKey)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }

    return message.slice(0, offset)
  }

  static toJSON(buf) {
    // { publicKey, signature, link, postType, channel, timestamp }
    let offset = 0
    // 1. get publicKey
    const publicKey = buf.slice(0, constants.PUBLICKEY_SIZE)
    offset += constants.PUBLICKEY_SIZE
    // 2. get signature
    const signature = buf.slice(offset, offset + constants.SIGNATURE_SIZE)
    offset += constants.SIGNATURE_SIZE
    // verify signature is correct
    const signaturePayload = buf.slice(constants.PUBLICKEY_SIZE)
    const payload = buf.slice(constants.PUBLICKEY_SIZE + constants.SIGNATURE_SIZE)
    const signatureCorrect = crypto.verify(signaturePayload, payload, publicKey)
    if (!signatureCorrect) { 
      throw new Error("could not verify created signature using keypair publicKey + secretKey") 
    }
    // 3. get link
    const link = buf.slice(offset, offset + constants.HASH_SIZE)
    offset += constants.HASH_SIZE
    // 4. get postType
    const postType = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    if (postType !== constants.LEAVE_POST) {
      return new Error(`"decoded postType (${postType}) is not of expected type (constants.LEAVE_POST)`)
    }
    // 5. get channelSize
    const channelSize = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes
    // 6. use channelSize to get channel
    const channel = buf.slice(offset, offset + channelSize).toString()
    offset += channelSize
    // 7. get timestamp
    const timestamp = decodeVarintSlice(buf, offset)
    offset += varint.decode.bytes

    return { publicKey, signature, link, postType, channel, timestamp }
  }
}


// peek returns the message type of a cablegram
function peek (buf) {
  // decode msg len, and discard
  decodeVarintSlice(buf, 0)
  const offset = varint.decode.bytes
  // decode and return msg type
  return decodeVarintSlice(buf, offset)
}

function prependMsgLen (buf) {
  const msglen = encodeVarintBuffer(buf.length)
  // prepend msglen before the contents and we're done
  return b4a.concat([msglen, buf])
}

// attempt to extract a varint from a buffer `frame`, starting at `offset`
function decodeVarintSlice (frame, offset) {
  let decodedSlice
  let sliceEnd 
  for (let i = 1; i < constants.MAX_VARINT_SIZE; i++) {
    sliceEnd = offset + i 
    const frameSlice = frame.slice(offset, sliceEnd)
    try {
      decodedSlice = varint.decode(frameSlice)
      return decodedSlice
    } catch (e) {
      if (e instanceof RangeError) {
        continue
      }
      throw RangeError
    }
  }
  return decodedSlice
}

function isInteger(n) {
  return Number.isInteger(n)
}

function isBufferSize(b, SIZE) {
  if (b4a.isBuffer(b)) {
    return b.length === SIZE
  }
  return false
}

function isString (s) {
  return typeof s === "string"
}

function isArrayHashes (arr) {
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      if (!isBufferSize(arr[i], constants.HASH_SIZE)) {
        return false
      }
      return true
    }
  }
  return false
}

function encodeVarintBuffer (n) {
  // take integer, return varint encoded buffer representation
  return b4a.from(varint.encode(n))
}

function writeVarint (n, buf, offset) {
  // take integer, buffer to write to, and offset to write at
  // return amount of varint encoded bytes written
  const varintBuf = encodeVarintBuffer(n)
  varintBuf.copy(buf, offset)
  return varint.encode.bytes
}

module.exports = { 
  HASH_RESPONSE, 
  DATA_RESPONSE, 
  HASH_REQUEST, 
  CANCEL_REQUEST, 
  TIME_RANGE_REQUEST, 
  CHANNEL_STATE_REQUEST, 
  CHANNEL_LIST_REQUEST, 

  TEXT_POST,
  DELETE_POST,
  // INFO_POST,
  TOPIC_POST,
  JOIN_POST,
  LEAVE_POST,

  peek 
}
