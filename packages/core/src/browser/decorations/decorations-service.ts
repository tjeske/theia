/********************************************************************************
 * Copyright (C) 2019 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable } from 'inversify';
import { CancellationTokenSource, Disposable, Emitter } from '../../common';
import { TernarySearchTree } from '../../common/ternary-search-tree';
import {
    IDecorationData,
    IDecorationsProvider,
    DecorationsService,
    IResourceDecorationChangeEvent
} from './decorations-protocol';
import { URI as VSCodeURI } from 'vscode-uri';
import URI from '../../common/uri';

class DecorationDataRequest {
    constructor(
        readonly source: CancellationTokenSource,
        readonly thenable: Promise<void>,
    ) { }
}

class DecorationProviderWrapper {

    readonly data: TernarySearchTree<URI, DecorationDataRequest | IDecorationData | undefined>;
    private readonly _dispoable: Disposable;

    constructor(
        readonly provider: IDecorationsProvider,
        // uriIdentityService: IUriIdentityService,
        private readonly _uriEmitter: Emitter<URI | URI[]>,
        private readonly _flushEmitter: Emitter<IResourceDecorationChangeEvent>
    ) {

        this.data = TernarySearchTree.forUris<DecorationDataRequest | IDecorationData | undefined>(true);

        this._dispoable = this.provider.onDidChange(uris => {
            if (!uris) {
                // flush event -> drop all data, can affect everything
                this.data.clear();
                this._flushEmitter.fire({ affectsResource(): boolean { return true; } });

            } else {
                // selective changes -> drop for resource, fetch again, send event
                // perf: the map stores thenables, decorations, or `null`-markers.
                // we make us of that and ignore all uris in which we have never
                // been interested.
                for (const uri of uris) {
                    this._fetchData(new URI(uri.toString()));
                }
            }
        });
    }

    dispose(): void {
        this._dispoable.dispose();
        this.data.clear();
    }

    knowsAbout(uri: URI): boolean {
        return !!this.data.get(uri) || Boolean(this.data.findSuperstr(uri));
    }

    getOrRetrieve(uri: URI, includeChildren: boolean, callback: (data: IDecorationData, isChild: boolean) => void): void {

        let item = this.data.get(uri);

        if (item === undefined) {
            // unknown -> trigger request
            item = this._fetchData(uri);
        }

        if (item && !(item instanceof DecorationDataRequest)) {
            // found something (which isn't pending anymore)
            callback(item, false);
        }

        if (includeChildren) {
            // (resolved) children
            const iter = this.data.findSuperstr(uri);
            if (iter) {
                let next = iter.next();
                while (!next.done) {
                    const value = next.value;
                    if (value && !(value instanceof DecorationDataRequest)) {
                        callback(value, true);
                    }
                    next = iter.next();
                }
            }
        }
    }

    private _fetchData(uri: URI): IDecorationData | undefined {

        // check for pending request and cancel it
        const pendingRequest = this.data.get(new URI(uri.toString()));
        if (pendingRequest instanceof DecorationDataRequest) {
            pendingRequest.source.cancel();
            this.data.delete(uri);
        }

        const source = new CancellationTokenSource();
        const dataOrThenable = this.provider.provideDecorations(VSCodeURI.parse(uri.toString()), source.token);
        if (!isThenable<IDecorationData | Promise<IDecorationData | undefined> | undefined>(dataOrThenable)) {
            // sync -> we have a result now
            return this._keepItem(uri, dataOrThenable);

        } else {
            // async -> we have a result soon
            const request = new DecorationDataRequest(source, Promise.resolve(dataOrThenable).then(data => {
                if (this.data.get(uri) === request) {
                    this._keepItem(uri, data);
                }
            }).catch(err => {
                if (!(err instanceof Error && err.name === 'Canceled' && err.message === 'Canceled') && this.data.get(uri) === request) {
                    this.data.delete(uri);
                }
            }));

            this.data.set(uri, request);
            return undefined;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function isThenable<T>(obj: any): obj is Promise<T> {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return obj && typeof (<Promise<any>>obj).then === 'function';
        }
    }

    private _keepItem(uri: URI, data: IDecorationData | undefined): IDecorationData | undefined {
        const deco = data ? data : undefined;
        const old = this.data.set(uri, deco);
        if (deco || old) {
            // only fire event when something changed
            this._uriEmitter.fire(uri);
        }
        return deco;
    }
}

@injectable()
export class DecorationsServiceImpl implements DecorationsService {
    declare readonly _serviceBrand: undefined;

    private readonly _data: DecorationProviderWrapper[] = [];
    private readonly _onDidChangeDecorationsDelayed = new Emitter<URI | URI[]>();
    private readonly onDidChangeDecorationsEmitter = new Emitter<IResourceDecorationChangeEvent>();
    // private readonly _decorationStyles: DecorationStyles;

    readonly onDidChangeDecorations = this.onDidChangeDecorationsEmitter.event;

    dispose(): void {
        // this._decorationStyles.dispose();
        this.onDidChangeDecorationsEmitter.dispose();
        this._onDidChangeDecorationsDelayed.dispose();
    }

    registerDecorationsProvider(provider: IDecorationsProvider): Disposable {

        const wrapper = new DecorationProviderWrapper(
            provider,
            // this._uriIdentityService,
            this._onDidChangeDecorationsDelayed,
            this.onDidChangeDecorationsEmitter
        );
        this._data.push(wrapper);

        this.onDidChangeDecorationsEmitter.fire({
            // everything might have changed
            affectsResource(): boolean { return true; }
        });

        return Disposable.create(() => {
            // fire event that says 'yes' for any resource
            // known to this provider. then dispose and remove it.
            this._data.splice(this._data.indexOf(wrapper), 1);
            this.onDidChangeDecorationsEmitter.fire({ affectsResource: uri => wrapper.knowsAbout(new URI(uri.toString())) });
            wrapper.dispose();
        });
    }

    getDecoration(uri: VSCodeURI, includeChildren: boolean): IDecorationData [] {
        const data: IDecorationData[] = [];
        let containsChildren: boolean = false;
        for (const wrapper of this._data) {
            wrapper.getOrRetrieve(new URI(uri.toString()), includeChildren, (deco, isChild) => {
                if (!isChild || deco.bubble) {
                    data.push(deco);
                    containsChildren = isChild || containsChildren;
                }
            });
        }
        return data;
    }
}
