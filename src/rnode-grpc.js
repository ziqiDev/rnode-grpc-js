import * as R from 'ramda'

const { log, warn } = console

const init = ({protoSchema}) => {
  // TODO: remove dependency on a specific namespace
  const casperTypes = protoSchema.nested.coop.nested.rchain.nested.casper.nested.protocol.nested
  // Dependency on `proto` global object generated by `protoc` tool
  const getTypeConstructor = name => proto.coop.rchain.casper.protocol[name] || proto[name]

  return {
    getType: name => casperTypes[name] || protoSchema.nested[name],
    getTypeConstructor,
    methods: {
      ...casperTypes.DeployService.methods,
      ...casperTypes.ProposeService.methods,
    },
  }
}

const resolveEither = eitherMsg => {
  const {value: valBytes, typeUrl} = eitherMsg.toObject().success.response
  const [_, type] = typeUrl.match(/^type.rchain.coop\/(.+)$/)
  const propPath = type.split('.')
  const propLens = R.map(R.lensProp, propPath)
  const typeLens = R.compose(...propLens)
  const typeDef = R.view(typeLens, proto)

  return typeDef.deserializeBinary(valBytes).toObject()
}

const fillObject = R.curry((getType, getTypeConstructor, reqTypeName, input) => {
  const msgConstructor = getTypeConstructor(reqTypeName)
  !msgConstructor && warn('Request type not found', reqTypeName)
  const req = new msgConstructor()
  Object.entries(input || {}).forEach(([k, v]) => {
    const typeDef = getType(reqTypeName)
    const genKey = k.replace(/_(\S)/g, (_, x) => x.toUpperCase())
    const field = typeDef.fields[genKey]
    !field && warn(`Property not found ${reqTypeName}.${k}`)

    // Handle collections (proto repeated)
    const isListType = field.rule === 'repeated'
    const setterSuffix = isListType ? `List` : ''
    const [fst, snd, ...tail] = genKey
    const setterName = f => R.flatten(
      ['set', fst.toUpperCase(), snd, f(tail.join('')), setterSuffix]
    ).join('')
    const setter = req[setterName(R.identity)] || req[setterName(R.toLower)]
    !setter && warn(
      `Property setter not found ${reqTypeName}.${k} (<gen-js>.${setterName})`
    )

    // Create property value / recursively resolve complex types
    const val =
      ~['bool', 'int32', 'sint64', 'string', 'bytes'].indexOf(field.type)
        // Simple type
        ? v
        // Complex type
        : isListType
          ? R.map(fillObject(getType, getTypeConstructor, field.type), v)
          : fillObject(getType, getTypeConstructor, field.type, v)

    // Set property value
    setter.bind(req)(val)
  })
  return req
})

const createApiMethod = R.curry((service, name, method, getType, getTypeConstructor) => async (input, meta) => {
  // const reqType = casperTypes[method.requestType]
  // const respType = casperTypes[method.responseType]
  const isReponseStream = !!method.responseStream
  const req = fillObject(getType, getTypeConstructor, method.requestType, input)

  if (isReponseStream) {
    const call = service[name](req, meta)
    const streamResult = []
    call.on('data', resultMsg => {
      const result = resolveEither(resultMsg)
      streamResult.push(result)
    })
    return new Promise(resolve => {
      call.on('end', _ => { resolve(streamResult) })
    })
  } else {
    return new Promise((resolve, reject) => {
      service[name](req, null, (err, resultMsg) => {
        if (err) reject(err)
        else {
          // Resolve Either value
          // TODO: handle Either error
          const result = resolveEither(resultMsg)
          resolve(result)
        }
      })
    })
  }
})

export const rnodeClient = (service, opt) => {
  const {getType, getTypeConstructor, methods} = init(opt)

  return R.mapObjIndexed((method, k) => createApiMethod(service, k, method, getType, getTypeConstructor), methods)
}
