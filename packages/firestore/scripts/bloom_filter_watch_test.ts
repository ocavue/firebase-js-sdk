/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// To execute this script run the following command in the parent directory:
// yarn build:scripts && node scripts/bloom_filter_watch_test.js

import * as yargs from 'yargs';

import { newConnection } from '../src/platform/connection';
import { DatabaseId, DatabaseInfo } from '../src/core/database_info';
import {
  DocumentChange,
  DocumentDelete,
  DocumentRemove,
  ExistenceFilter,
  ListenRequest,
  ListenResponse,
  TargetChange
} from '../src/protos/firestore_proto_api';

// Import the following modules despite not using them. This forces them to get
// transpiled by tsc. Without these imports they do not get transpiled because
// they are imported dynamically, causing in MODULE_NOT_FOUND errors at runtime.
import * as node_connection from '../src/platform/node/connection';
import * as node_format_json from '../src/platform/node/format_json';
import {Connection, Stream} from "../src/remote/connection";
import {Deferred} from "../test/util/promise";

async function main() {
  const {projectId, host, ssl} = parseArgs();
  log(`Connecting to Firestore host ${host} using project ID ${projectId}`);
  const connection = createConnection(projectId, host, ssl);
  const watchStream = new WatchStream(connection, projectId);
  await watchStream.open();
  try {
    log("Adding target to watch stream");
    watchStream.addTarget(1, "TestCollection", "TestKey", "TestValue");
  } finally {
    log("Closing watch stream");
    await watchStream.close();
    log("Watch stream closed");
  }
}

interface ParsedArgs {
  projectId: string;
  host: string;
  ssl: boolean;
  collectionId: string | null;
  documentCreateCount: number;
  documentDeleteCount: number;
  iterationCount: number;
}

function parseArgs(): ParsedArgs {
  const parsedArgs = yargs
    .strict()
    .config()
    .options({
      projectId: {
        demandOption: true,
        type: "string",
        describe: "The Firebase project ID to use."
      },
      host: {
        type: "string",
        default: "firestore.googleapis.com",
        describe: "The Firestore server to which to connect."
      },
      ssl: {
        type: "boolean",
        default: true,
        describe: "Whether to use SSL when connecting to the Firestore server."
      },
      collection: {
        type: "string",
        describe: "The ID of the Firestore collection to use; " +
          "an auto-generated ID will be used if not specified."
      },
      creates: {
        type: "number",
        default: 10,
        describe: "The number of Firestore documents to create."
      },
      deletes: {
        type: "number",
        default: 5,
        describe: "The number of documents to delete."
      },
      iterations: {
        type: "number",
        default: 20,
        describe: "The number of iterations to run."
      }
    })
    .help()
    .parseSync();

  return {
    projectId: parsedArgs.projectId,
    host: parsedArgs.host,
    ssl: parsedArgs.ssl,
    collectionId: parsedArgs.collection ?? null,
    documentCreateCount: parsedArgs.creates,
    documentDeleteCount: parsedArgs.deletes,
    iterationCount: parsedArgs.iterations
  };
}

function createConnection(projectId: string, host: string, ssl: boolean): Connection {
  return newConnection(new DatabaseInfo(
    new DatabaseId(projectId),
    /*appId=*/"",
    /*persistenceKey=*/"[DEFAULT]",
    host,
    ssl,
    /*forceLongPolling=*/false,
    /*autoDetectLongPolling=*/false,
    /*useFetchStreams=*/true
  ));
}

function log(...args: Array<any>): void {
  console.log(...args);
}

class WatchError extends Error {
  name = "WatchError";
}

class TargetStateError extends Error {
  name = "TargetStateError";
}

class TargetState {
  private _added = false;
  private _current = false;
  private _resumeToken: string | Uint8Array | null = null;

  onAdded(): void {
    if (this._added) {
      throw new TargetStateError(`onAdded() invoked when already added.`);
    }
    this._added = true;
    this._current = false;
  }

  onRemoved(): void {
    if (!this._added) {
      throw new TargetStateError(`onRemoved() invoked when not added.`);
    }
    this._added = false;
    this._current = false;
  }

  onCurrent(): void {
    if (!this._added) {
      throw new TargetStateError(`onCurrent() invoked when not added.`);
    }
    this._current = true;
  }

  onReset(): void {
    if (!this._added) {
      throw new TargetStateError(`onReset() invoked when not added.`);
    }
    this._current = false;
  }

  onNoChange(resumeToken: string | Uint8Array | null): void {
    if (!this._added) {
      throw new TargetStateError(`onNoChange() invoked when not added.`);
    } else if (!this._current) {
      throw new TargetStateError(`onNoChange() invoked when not current.`);
    }
    if (resumeToken !== null) {
      this._resumeToken = resumeToken;
    }
  }
}

class WatchStream {

  private _stream: Stream<unknown, unknown> | null = null;
  private _closed = false;
  private _closedDeferred = new Deferred();

  private _targets = new Map<number, TargetState>();

  constructor(
    private readonly _connection: Connection,
    private readonly _projectId: string) {
  }

  async open(): Promise<void> {
    if (this._stream) {
      throw new WatchError("open() may only be called once");
    } else if (this._closed) {
      throw new WatchError("open() may not be called after close()");
    }

    const deferred = new Deferred();

    const stream = this._connection.openStream("Listen", null, null);
    try {
      stream.onOpen(() => {
        deferred.resolve(null);
      });

      stream.onClose(err => {
        if (err) {
          deferred.reject(err as Error);
          this._closedDeferred.reject(err as Error);
        } else {
          deferred.resolve(null);
          this._closedDeferred.resolve(null);
        }
      });

      stream.onMessage(msg => {
        this._onMessageReceived(msg as ListenResponse);
      });
    } catch (err) {
      stream.close();
      throw err;
    }

    this._stream = stream;

    await deferred.promise;
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;

    if (! this._stream) {
      return;
    }

    this._stream.close();
    await this._closedDeferred.promise;
  }

  addTarget(targetId: number, collectionId: string, keyFilter: string, valueFilter: string): void {
    if (!this._stream) {
      throw new WatchError("open() must be called before addTarget()");
    } else if (this._closed) {
      throw new WatchError("addTarget() may not be called after close()");
    } else if (this._targets.has(targetId)) {
      throw new WatchError(`targetId ${targetId} is already used`);
    }

    const target: ListenRequest = {
      addTarget: {
        targetId: targetId,
        query: {
          parent: `projects/${this._projectId}/databases/(default)/documents`,
          structuredQuery: {
            from: [{collectionId: collectionId}],
            where: {
              fieldFilter: {
                field: {
                  fieldPath: keyFilter
                },
                op: "EQUAL",
                value: {
                  stringValue: valueFilter
                }
              }
            },
          },
        },
      }
    };

    this._stream.send(target);

    this._targets.set(targetId, new TargetState());
  }

  private _onMessageReceived(msg: ListenResponse): void {
    if (msg.targetChange) {
      this._onTargetChange(msg.targetChange);
    } else if (msg.documentChange) {
      this._onDocumentChange(msg.documentChange);
    } else if (msg.documentRemove) {
      this._onDocumentRemove(msg.documentRemove);
    } else if (msg.documentDelete) {
      this._onDocumentDelete(msg.documentDelete);
    } else if (msg.filter) {
      this._onExistenceFilter(msg.filter);
    }
  }

  private _targetStatesForTargetChange(targetChange: TargetChange): Array<TargetState> {
    const targetIds = targetChange.targetIds;
    const targetStates = Array.from(targetIds ?? [], targetId => {
      const targetState = this._targets.get(targetId);
      if (targetState === undefined) {
        throw new WatchError(`TargetChange specifies an unknown targetId: ${targetId}`);
      }
      return targetState;
    });

    if (targetStates.length > 0) {
      return targetStates;
    }

    // If an empty list of target IDs was specified, then this means that the
    // event applies to _all_ targets.
    return Array.from(this._targets.values());
  }

  private _onTargetChange(targetChange: TargetChange): void {
    const targetStates = this._targetStatesForTargetChange(targetChange);
    for (const targetState of targetStates) {
      switch (targetChange.targetChangeType) {
        case "ADD":
          targetState.onAdded();
          break;
        case "REMOVE":
          targetState.onRemoved();
          break;
        case "CURRENT":
          targetState.onCurrent();
          break;
        case "RESET":
          targetState.onReset();
          break;
        case "NO_CHANGE":
          targetState.onNoChange(targetChange.resumeToken ?? null);
          break;
        default:
          throw new WatchError(`unknown targetChangeType: ${targetChange.targetChangeType}`);
      }
    }
  }

  private _onDocumentChange(documentChange: DocumentChange): void {
  }

  private _onDocumentRemove(documentRemove: DocumentRemove): void {
  }

  private _onDocumentDelete(documentDelete: DocumentDelete): void {
  }

  private _onExistenceFilter(existenceFilter: ExistenceFilter): void {
  }
}

main();
