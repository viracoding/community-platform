/*
  This provides a go-between for stores and the database. The reason for this is
  a) to make it easier to change database provider/model in the future
  b) to enforce specific patterns when interacting with the database, such as setting metadata
*/

import { Subject } from 'rxjs'
import { afs } from 'src/utils/firebase'
import { firestore } from 'firebase/app'
export class Database {
  /****************************************************************************** *
        Available Functions
  /****************************************************************************** */

  // get a group of docs. returns an observable, first pulling from local cache and then searching for updates
  public static getCollection(path: string) {
    const collection$ = new Subject<any[]>()
    this._emitCollectionUpdates(path, collection$)
    return collection$
  }

  // get cached value, emit, and then subscribe and emit any updates
  public static async _emitCollectionUpdates(
    path: string,
    subject: Subject<any[]>,
  ) {
    // get cached and emit
    const cachedSnapshot = await this._getCachedCollection(path)
    let cached = this._preProcessData(cachedSnapshot)
    subject.next([...cached].reverse())
    // subscribe to any updates, emit when received
    const updatesRef = this._getCollectionUpdatesRef(
      path,
      cached[cached.length - 1],
    )
    updatesRef.onSnapshot(updateSnapshot => {
      const update = this._preProcessData(updateSnapshot)
      cached = this._mergeData(cached, update)
      subject.next([...cached].reverse())
    })
  }

  // get a single doc. returns an observable, first pulling from local cache and then searching for updates
  public static getDoc(path: string) {
    const doc$ = new Subject()
    afs
      .doc(path)
      .get({ source: 'cache' })
      .then(cached => {
        // emit cached values and look for fresh
        doc$.next(cached.data())
        afs.doc(path).onSnapshot(update => doc$.next(update.data()))
      })
    return doc$
  }

  public static setDoc(path: string, docValues: any) {
    return afs.doc(path).set({ ...docValues, _modified: new Date() })
  }
  // to allow caching to work docs are not completed deleted from the database, but instead emptied and marked as deleted
  // we could consider changing this to a full delete if it can be verified that users' cache won't repeatedly show the deleted doc
  public static deleteDoc(path: string) {
    return afs.doc(path).set({
      _modified: new Date(),
      _deleted: true,
    })
  }

  public static async queryCollection(
    path: string,
    field: string,
    operation: firestore.WhereFilterOp,
    value: string,
  ) {
    const data = await afs
      .collection(path)
      .where(field, operation, value)
      .get()
    return data.docs.map(doc => doc.data())
  }

  /****************************************************************************** *
        Helper Methods
  /****************************************************************************** */

  // search the persisted cache for documents, return oldest to newest
  private static _getCachedCollection(path: string) {
    return afs
      .collection(path)
      .orderBy('_modified', 'asc')
      .get({ source: 'cache' })
  }
  // get any documents that have been updated since last document in cache
  // if no documents in cache fetch everything
  private static _getCollectionUpdatesRef(path: string, latestDoc?: any) {
    return afs
      .collection(path)
      .orderBy('_modified', 'asc')
      .startAfter(latestDoc ? latestDoc._modified : -1)
  }

  // when data comes in from firebase we want to preprocess, to extract the document data from firestore
  // documents, populate a _id field (if not present) and remove deleted items
  private static _preProcessData(data: firestore.QuerySnapshot) {
    const docs = data.docs.map(doc => {
      return { ...doc.data(), _id: doc.id }
    }) as any[]
    const filtered = docs.filter(doc => !doc._deleted)
    return filtered
  }

  // when we have both cached and updated data retrieved, we want to merge so that any documents
  // that have been updated don't appear in both lists
  private static _mergeData(cached: any[], updates: any[]) {
    const json = {}
    cached.forEach(d => {
      json[d._id] = d
    })
    updates.forEach(d => {
      json[d._id] = d
    })
    return Object.values(json)
  }
}