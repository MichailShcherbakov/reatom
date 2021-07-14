import {
  AC,
  Action,
  ActionCreatorData,
  ActionType,
  addToSetsMap,
  Atom,
  Cache,
  CacheDep,
  callSafety,
  createTransaction,
  delFromSetsMap,
  Fn,
  invalid,
  isAction,
  isActionCreator,
  isAtom,
  isFunction,
  noop,
  Rec,
  Store,
  TransactionResult,
  Unsubscribe,
} from './internal'

// TODO: tsdx
// if (process.env.NODE_ENV !== 'production') {
//   let i = 0

//   var incrementGetStateOveruse = () => {
//     if (i++ < 3) return

//   incrementGetStateOveruse = () => {}

//     console.warn(
//       `Full state requests too often, it may slow down the application`,
//       `Use subscription to patch instead or request partial state by \`getState(atom)\``,
//     )
//   }

//   setInterval(() => (i = 0), 3000)
// }

function isTypesChange(
  depsOld: Cache['deps'],
  depsNew: Cache['deps'],
): boolean {
  return (
    depsOld.length != depsNew.length ||
    depsOld.some(
      ({ cache }, i) =>
        cache.types != depsNew[i].cache.types ||
        isTypesChange(cache.deps, depsNew[i].cache.deps),
    )
  )
}

export function createStore(snapshot: Record<string, any> = {}): Store {
  const actionsReducers = new Map<ActionType, Set<Atom>>()
  const actionsListeners = new Map<ActionType, Set<Fn>>()
  const atomsCache = new WeakMap<Atom, Cache>()
  const atomsListeners = new Map<Atom, Set<Fn>>()
  const transactionListeners = new Set<Fn<[TransactionResult]>>()

  function addReducer(atom: Atom, cache: Cache) {
    cache.types.forEach((type) => addToSetsMap(actionsReducers, type, atom))
    cache.deps.forEach((dep) => addReducer(atom, dep.cache))
  }
  function delReducer(atom: Atom, cache: Cache) {
    cache.types.forEach((type) => delFromSetsMap(actionsReducers, type, atom))
    cache.deps.forEach((dep) => delReducer(atom, dep.cache))
  }

  function collect(atom: Atom, result: Rec = {}) {
    const { state, deps } = getCache(atom)!

    result[atom.id] = state
    deps.forEach((dep) => collect(dep.atom, result))

    return result
  }

  function mergePatch(atom: Atom, patch: Cache, changedAtoms: Array<CacheDep>) {
    const atomCache = getCache(atom)
    if (atomsListeners.has(atom)) {
      if (atomCache == undefined) {
        addReducer(atom, patch)
      } else if (
        atomCache.types != patch.types ||
        isTypesChange(atomCache.deps, patch.deps)
      ) {
        delReducer(atom, patch)
        addReducer(atom, patch)
      }
    }

    atomsCache.set(atom, patch)

    if (!Object.is(atomCache?.state, patch.state)) {
      changedAtoms.push({ atom, cache: patch })
    }
  }

  const dispatch: Store['dispatch'] = (action: Action | Array<Action>) => {
    const actions = Array.isArray(action) ? action : [action]
    invalid(
      actions.length === 0 || actions.every(isAction) === false,
      `dispatch arguments`,
    )

    const patch = new Map<Atom, Cache>()
    const transaction = createTransaction(actions, patch, getCache, snapshot)
    const changedAtoms = new Array<CacheDep>()
    let error: Error | null = null

    try {
      actions.forEach(({ targets }) =>
        targets?.forEach((atom) => transaction.process(atom)),
      )
      actions.forEach(({ type }) =>
        actionsReducers.get(type)?.forEach((atom) => transaction.process(atom)),
      )

      patch.forEach((atomPatch, atom) =>
        mergePatch(atom, atomPatch, changedAtoms),
      )
    } catch (e) {
      error = e instanceof Error ? e : new Error(e)
    }

    const transactionResult: TransactionResult = { actions, error, patch }

    transactionListeners.forEach((cb) => callSafety(cb, transactionResult))

    if (error) throw error

    changedAtoms.forEach(({ atom, cache: { state } }) =>
      atomsListeners.get(atom)?.forEach((cb) => callSafety(cb, state)),
    )

    actions.forEach((action) =>
      actionsListeners
        .get(action.type)
        ?.forEach((cb) => callSafety(cb, action)),
    )

    return Promise.allSettled(
      transaction.effects.map((cb) => new Promise((res) => res(cb(store)))),
    ).then(noop, noop)
  }

  function getCache<T>(atom: Atom<T>): Cache<T> | undefined {
    return atomsCache.get(atom)
  }

  function getState<T>(): Record<string, any>
  function getState<T>(atom: Atom<T>): T
  function getState<T>(atom?: Atom<T>) {
    if (atom === undefined) {
      // if (process.env.NODE_ENV !== 'production') {
      //   incrementGetStateOveruse()
      // }

      const result: Rec = {}

      atomsListeners.forEach((_, atom) => collect(atom, result))

      return result
    }

    invalid(!isAtom(atom), `"getState" argument`)

    let atomCache = getCache(atom)

    if (atomCache === undefined) {
      dispatch({
        type: `init "${atom.id}" ~${Math.random().toString(36)}`,
        payload: null,
        targets: [atom],
      })

      atomCache = getCache(atom)!
    }

    return atomCache.state
  }

  function init(...atoms: Array<Atom>) {
    const unsubscribers = atoms.map((atom) => subscribeAtom(atom, noop))
    return () => unsubscribers.forEach((un) => un())
  }

  function subscribeAtom<T>(atom: Atom<T>, cb: Fn<[T]>): Unsubscribe {
    let listeners = atomsListeners.get(atom)

    if (listeners === undefined) {
      atomsListeners.set(atom, (listeners = new Set()))
    }

    listeners.add(cb)

    function unsubscribe() {
      listeners!.delete(cb)
      if (listeners!.size === 0) {
        atomsListeners.delete(atom)
        delReducer(atom, atomsCache.get(atom)!)
      }
    }

    const atomCache = getCache(atom)

    try {
      getState(atom)

      const { state } = getCache(atom)!
      if (Object.is(atomCache?.state, state)) {
        cb(state)
      }

      return unsubscribe
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  function subscribeAction<T extends AC>(
    actionCreator: T,
    cb: Fn<[ActionCreatorData<AC>]>,
  ): Unsubscribe {
    addToSetsMap(actionsListeners, actionCreator.type, cb)

    return () => delFromSetsMap(actionsListeners, actionCreator.type, cb)
  }

  function subscribeTransaction(cb: Fn<[TransactionResult]>): Unsubscribe {
    transactionListeners.add(cb)

    return () => transactionListeners.delete(cb)
  }

  function subscribe<T>(
    cb: Fn<[transactionResult: TransactionResult]>,
  ): Unsubscribe
  function subscribe<T>(atom: Atom<T>, cb: Fn<[state: T]>): Unsubscribe
  function subscribe<T extends AC>(
    actionCreator: T,
    cb: Fn<[action: ActionCreatorData<AC>]>,
  ): Unsubscribe
  function subscribe(
    ...a: [Fn<[TransactionResult]>] | [Atom, Fn] | [AC, Fn]
  ): Unsubscribe {
    return a.length === 1 && isFunction(a[0])
      ? subscribeTransaction(a[0])
      : isAtom(a[0]) && isFunction(a[1])
      ? subscribeAtom(a[0], a[1])
      : isActionCreator(a[0]) && isFunction(a[1])
      ? subscribeAction(a[0], a[1])
      : (invalid(1, `subscribe arguments`) as never)
  }

  const store = {
    dispatch,
    getCache,
    getState,
    init,
    subscribe,
  }

  return store
}

export const defaultStore = createStore()
