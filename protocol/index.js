import setupDebug from 'debug'
const debug = setupDebug('nydus-protocol')

export const protocolVersion = 3

export const WELCOME = 0
export const INVOKE = 1
export const RESULT = 2
export const ERROR = 3
export const PUBLISH = 4

const LAST_TYPE = PUBLISH

export const PARSER_ERROR = 11
const parserError = { type: PARSER_ERROR }


export function encode(type, data, id = null, path = null) {
  let output = '' + type
  if (id != null) {
    output += '$' + id
  }
  if (path != null) {
    output += '~' + encodeURI(path)
  }
  if (data === undefined) {
    output += '|'
  } else {
    output += '|' + JSON.stringify(data)
  }

  return output
}

function validate(type, id, path, data) {
  switch (type) {
    case WELCOME:
      if (id != null || path != null) {
        debug('invalid WELCOME message, no id or path allowed')
        return parserError
      }
      if (data !== protocolVersion) {
        debug('invalid WELCOME message, unsupported protocol version')
        return parserError
      }
      break
    case INVOKE:
      if (id == null || path == null) {
        debug('invalid INVOKE message, id and path required')
        return parserError
      }
      break
    case RESULT:
      if (id == null) {
        debug('invalid RESULT message, id is required')
        return parserError
      }
      if (path != null) {
        debug('invalid RESULT message, path is not allowed')
        return parserError
      }
      break
    case ERROR:
      if (id == null) {
        debug('invalid RESULT message, id is required')
        return parserError
      }
      if (path != null) {
        debug('invalid RESULT message, path is not allowed')
        return parserError
      }
      break
    case PUBLISH:
      if (id != null) {
        debug('invalid PUBLISH message, id is not allowed')
        return parserError
      }
      if (path == null) {
        debug('invalid PUBLISH message, path is required')
        return parserError
      }
      break
  }

  return { type, id, path, data }
}

const JSON_ERROR = {}
function tryParse(str) {
  try {
    return JSON.parse(str)
  } catch (err) {
    return JSON_ERROR
  }
}

export function decode(str) {
  if (str.length < 2) {
    debug('invalid nydus message, too short')
    return parserError
  }

  const type = +str[0]
  if (isNaN(type) || type > LAST_TYPE) {
    debug('invalid nydus message, unrecognized type')
    return parserError
  }

  let id
  let path
  let data

  let begin = 2
  let i = 2
  const len = str.length
  if (str[i - 1] === '$') {
    for (; i < len; i++) {
      if (str[i] === '~' || str[i] === '|') {
        id = str.slice(begin, i)
        i++
        break
      }
      if (i - begin > 32) {
        debug('invalid nydus message, id too long')
        return parserError
      }
    }

    if (id == null || !id.length) {
      debug('invalid nydus message, empty id specified')
      return parserError
    }
  }

  begin = i
  if (str[i - 1] === '~') {
    for (; i < len; i++) {
      if (str[i] === '|') {
        path = decodeURI(str.slice(begin, i))
        i++
        break
      }
      if (i - begin > 1024) {
        debug('invalid nydus message, path too long')
        return parserError
      }
    }

    if (path == null || !path.length) {
      debug('invalid nydus message, empty path specified')
      return parserError
    }
  }

  if (str[i - 1] !== '|') {
    debug('invalid nydus message, no body found')
    return parserError
  }
  if (i < len) {
    data = tryParse(str.slice(i))
    if (data === JSON_ERROR) {
      debug('invalid nydus message, invalid JSON')
      return parserError
    }
  }

  return validate(type, id, path, data)
}
